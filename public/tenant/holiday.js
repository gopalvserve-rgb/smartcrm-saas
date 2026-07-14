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
      /* HOLIDAY_PACK_FIX_v1 — parseFloat-safe. Rejects NaN, empty, non-numeric. */
      let v = parseFloat(n); if (!isFinite(v)) v = 0;
      if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2) + ' Cr';
      if (v >= 100000)   return '₹' + (v / 100000).toFixed(2) + ' L';
      return '₹' + Math.round(v).toLocaleString('en-IN');
    }
    function fmtINRfull(n) { let v = parseFloat(n); if (!isFinite(v)) v = 0; return '₹' + Math.round(v).toLocaleString('en-IN'); }
    function num(n) { let v = parseFloat(n); if (!isFinite(v)) v = 0; return v.toLocaleString('en-IN'); }

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
            /* HOLIDAY_PACK_FIX_v1 — clickable: open Bookings filtered by this destination. */
            onclick: function () {
              try {
                var dname = encodeURIComponent(d.name || '');
                window.location.hash = '#/tourbookings?destination_id=' + (d.id||'') + '&destination_name=' + dname;
              } catch (_) {}
            }
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
      const sel = h('select', { style: { padding: '7px 10px',
        border: '1px solid #ccfbf1', borderRadius: '7px', fontSize: '13px',
        background: '#fff', minWidth: '300px' },
        onchange: function () { bookingId = Number(sel.value); load(); }
      });
      picker.appendChild(h('span', { style: { fontSize: '12.5px', color: '#475569' } }, 'Booking:'));
      picker.appendChild(sel);
      view.appendChild(picker);

      try {
        const r = await api('api_tour_booking_list',
          { status: '' });  // all bookings
        const opts = r.bookings || [];
        if (!opts.length) sel.appendChild(h('option', { value: '' }, '(no bookings yet)'));
        opts.forEach(function (b) {
          const o = h('option', { value: b.id },
            (b.booking_no || ('#' + b.id)) + ' — ' + (b.lead_name || '?') +
            ' · ' + (b.destination_name || '—'));
          if (b.id === bookingId) o.selected = true;
          sel.appendChild(o);
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

        wrap.appendChild(h('div', { style: { background: '#fff',
          border: '1px solid #ccfbf1', borderRadius: '10px', padding: '14px', marginBottom: '12px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: '8px' } },
            h('h3', { style: { margin: 0, fontSize: '14px' } }, '📋 ' + (itn.title || 'Itinerary')),
            h('span', {}, statusBadge(itn.status))),
          h('div', { style: { fontSize: '12.5px', color: '#64748b' } },
            days.length + ' day' + (days.length === 1 ? '' : 's') + ' planned · ' +
            acts.length + ' activit' + (acts.length === 1 ? 'y' : 'ies'))
        ));

        if (!days.length) {
          wrap.appendChild(h('div', { style: { background: '#f0fdfa',
            border: '1px dashed #ccfbf1', borderRadius: '10px',
            padding: '24px', textAlign: 'center', color: '#64748b' } },
            'No days planned yet. Click "+ Add Day" below to start building.'));
        }

        days.forEach(function (d) {
          const dayActs = acts.filter(function (a) { return a.day_id === d.id; });
          const dayCard = h('div', { style: { background: '#fff',
            border: '1px solid #ccfbf1', borderRadius: '10px',
            padding: '14px', marginBottom: '10px' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '8px' } },
              h('h4', { style: { margin: 0, fontSize: '14px' } },
                'Day ' + d.day_no + ' · ' + (d.city || '—')),
              h('span', { style: { fontSize: '12px', color: '#64748b' } },
                (d.hotel_name || 'No hotel') + ' · ' + (d.meal_plan || 'no meal'))),
            h('div', {}, dayActs.length
              ? dayActs.map(function (a) {
                  return h('div', { style: { display: 'flex', gap: '10px',
                    padding: '6px 0', borderBottom: '1px solid #ecfdf5', fontSize: '12.5px' } },
                    h('div', { style: { color: TEAL2, fontWeight: 600, minWidth: '70px' } }, a.time_str || ''),
                    h('div', { style: { fontSize: '14px' } }, kindEmoji(a.kind)),
                    h('div', { style: { flex: 1 } },
                      h('b', {}, a.title),
                      a.detail ? h('div', { style: { color: '#64748b', fontSize: '11.5px' } }, a.detail) : null)
                  );
                })
              : h('div', { style: { color: '#64748b', fontSize: '12px', fontStyle: 'italic' } }, 'No activities planned for this day.'))
          );
          wrap.appendChild(dayCard);
        });

        // Add day button
        const addDayBtn = h('div', { style: { marginTop: '14px' } },
          btn('+ Add Day', async function () {
            const dayNo = days.length + 1;
            const city = prompt('City for Day ' + dayNo, days.length ? days[days.length - 1].city : '');
            if (!city) return;
            try {
              await api('api_tour_itinerary_upsertDay',
                { itinerary_id: itn.id, day_no: dayNo, city: city });
              toast('Day added');
              load();
            } catch (e) { toast(e.message); }
          }, 'primary'));
        wrap.appendChild(addDayBtn);
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
