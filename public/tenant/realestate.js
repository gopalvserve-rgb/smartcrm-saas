/* ============================================================================
 * RE_PACK_v2 — isolated SPA module (2026-06-27)
 *
 * Loaded by public/tenant/index.html as a script after app.js.
 * All Real Estate v2 VIEWS live here so app.js never grows.
 *
 * Pages:
 *   - VIEWS.relistings         — Listings grid with filters + share/tour/PDF
 *   - VIEWS.revirtualtours     — Tour library + viewer (Pannellum/YouTube/Matterport)
 *   - VIEWS.repropertyanalytics — Per-listing analytics dashboard
 *   - VIEWS.redealpipeline     — Deal pipeline (List/Kanban/Timeline)
 *   - VIEWS.reremotetools      — e-sign + token link + booking + WA templates
 *   - VIEWS.redocuments        — RE-categorized vault
 *   - VIEWS.remarketinsights   — Macro market data
 *   - VIEWS.reaiinsights       — Rule-based RE insights
 *
 * Backend APIs in routes/packs/realestate.js (RE_PACK_v2 block)
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

    const BLUE = '#2563eb', BLUE2 = '#1d4ed8';

    function fmtINR(n) {
      const v = Number(n || 0);
      if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2) + ' Cr';
      if (v >= 100000)   return '₹' + (v / 100000).toFixed(2) + ' L';
      return '₹' + Math.round(v).toLocaleString('en-IN');
    }
    function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

    function kpiTile(label, val, sub, color) {
      color = color || BLUE;
      return h('div', { style: {
        background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px',
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
        amber:  { bg: '#fef3c7', fg: '#92400e' }
      };
      const c = map[kind] || map.gray;
      return h('span', { style: {
        background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: '99px',
        fontSize: '11px', fontWeight: 600, display: 'inline-block'
      } }, text);
    }

    function btn(label, onclick, kind) {
      const style = kind === 'primary'
        ? { background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff',
            border: 0, padding: '7px 12px', borderRadius: '7px', fontWeight: 600,
            fontSize: '12.5px', cursor: 'pointer' }
        : { background: '#fff', border: '1px solid #dbeafe', color: '#0f172a',
            padding: '7px 12px', borderRadius: '7px', fontWeight: 600,
            fontSize: '12.5px', cursor: 'pointer' };
      return h('button', { style, onclick }, label);
    }

    function topbar(crumb, title, actions) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '14px', paddingBottom: '12px',
        borderBottom: '1px solid #dbeafe' } },
        h('div', {},
          h('div', { style: { fontSize: '12px', color: '#64748b' } }, crumb),
          h('h1', { style: { fontSize: '20px', margin: '4px 0 0' } }, title)
        ),
        h('div', { style: { display: 'flex', gap: '6px' } }, ...(actions || []))
      );
    }

    // ════════════════════════════════════════════════════════════════
    //  LISTINGS — grid + filters + edit modal + share/PDF/WA actions
    // ════════════════════════════════════════════════════════════════
    VIEWS.relistings = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Real Estate / Listings', '🏘️ Property Listings', [
        btn('🌱 Seed Demo Data', async function () {
          if (!confirm('Insert ~25 listings + 18 deals + analytics events?')) return;
          try { const r = await api('api_re_seedDemoV2');
            if (r.skipped) toast('Demo data already present');
            else if (r.ok) { toast('✓ Seeded'); setTimeout(function(){ window.location.reload(); }, 800); }
          } catch (e) { toast('Seed failed: ' + e.message); }
        }),
        btn('+ Add Listing', function () { openListingModal(null, refresh); }, 'primary')
      ]));

      // Filters
      const toolbar = h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
        borderRadius: '10px', padding: '10px 14px', marginBottom: '12px',
        display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } });
      const search = h('input', { placeholder: '🔍 Locality / RERA / landmark',
        style: { padding: '7px 10px', border: '1px solid #dbeafe', borderRadius: '7px',
          fontSize: '13px', minWidth: '220px' } });
      const txn = h('select', { style: selStyle(), onchange: refresh },
        opt('', 'All transactions'), opt('sale', 'Sale'), opt('rent', 'Rent'), opt('lease', 'Lease'));
      const typeF = h('select', { style: selStyle(), onchange: refresh },
        opt('', 'All types'), opt('residential', 'Residential'), opt('commercial', 'Commercial'),
        opt('plot', 'Plot'), opt('villa', 'Villa'), opt('farmhouse', 'Farmhouse'));
      const bhk = h('select', { style: selStyle(), onchange: refresh },
        opt('', 'All BHKs'), opt('1 BHK', '1 BHK'), opt('2 BHK', '2 BHK'),
        opt('3 BHK', '3 BHK'), opt('4 BHK', '4 BHK'), opt('5 BHK', '5+ BHK'));
      const status = h('select', { style: selStyle(), onchange: refresh },
        opt('', 'All statuses'), opt('available', 'Available'), opt('under_offer', 'Under offer'),
        opt('booked', 'Booked'), opt('sold', 'Sold'), opt('rented', 'Rented'));
      toolbar.appendChild(search); toolbar.appendChild(txn); toolbar.appendChild(typeF);
      toolbar.appendChild(bhk); toolbar.appendChild(status);
      toolbar.appendChild(btn('🔄', refresh));
      view.appendChild(toolbar);

      const wrap = h('div'); view.appendChild(wrap);
      let _t;
      search.addEventListener('input', function () { clearTimeout(_t); _t = setTimeout(refresh, 250); });

      function opt(v, l) { return h('option', { value: v }, l); }
      function selStyle() { return { padding: '7px 10px', border: '1px solid #dbeafe',
        borderRadius: '7px', fontSize: '13px', background: '#fff' }; }

      async function refresh() {
        wrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let data;
        try {
          const args = { search: search.value || '' };
          if (txn.value) args.transaction = txn.value;
          if (typeF.value) args.type = typeF.value;
          if (bhk.value) args.bhk = bhk.value;
          if (status.value) args.status = status.value;
          data = await api('api_re_listing_list', args);
        } catch (e) {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        wrap.innerHTML = '';
        const ls = data.listings || [];
        if (!ls.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px', color: '#64748b' } },
            'No listings match. Click 🌱 Seed Demo or + Add Listing to start.'));
          return;
        }

        // Showing N count
        wrap.appendChild(h('div', { style: { fontSize: '12px', color: '#64748b', marginBottom: '8px' } },
          'Showing ' + ls.length + ' listings'));

        const grid = h('div', { style: { display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '14px' } });

        ls.forEach(function (L) {
          const card = h('div', {
            style: { background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px',
              overflow: 'hidden', cursor: 'pointer', transition: 'all .15s' },
            onclick: function () { openListingDetail(L); }
          });
          // Photo strip
          const photo = h('div', { style: { height: '180px',
            background: 'linear-gradient(135deg,#dbeafe,#bfdbfe)',
            position: 'relative', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '50px', color: '#3b82f6' } },
            iconForType(L.type));
          if (L.cover_photo_url) {
            photo.style.background = "url('" + L.cover_photo_url + "') center/cover";
            photo.textContent = '';
          }
          photo.appendChild(h('span', { style: { position: 'absolute', top: '8px', right: '8px' } },
            statusPill(L.status)));
          if (L.photo_count) {
            photo.appendChild(h('span', { style: { position: 'absolute', bottom: '8px', right: '8px',
              background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: '10px',
              padding: '2px 6px', borderRadius: '99px' } }, '📷 ' + L.photo_count));
          }
          if (L.virtual_tour_url || L.video_tour_url) {
            const kinds = [];
            if (L.virtual_tour_url) kinds.push('🌐 360°');
            if (L.video_tour_url) kinds.push('🎥 Video');
            photo.appendChild(h('span', { style: { position: 'absolute', bottom: '8px', left: '8px',
              background: 'rgba(220,38,38,.85)', color: '#fff', fontSize: '10px',
              padding: '2px 6px', borderRadius: '99px', fontWeight: 700 } }, kinds.join(' ')));
          }
          card.appendChild(photo);
          // Info
          const info = h('div', { style: { padding: '12px' } },
            h('h3', { style: { fontSize: '14px', margin: '0 0 4px' } }, L.title || '—'),
            h('div', { style: { fontSize: '11.5px', color: '#64748b', marginBottom: '8px' } },
              '📍 ' + (L.locality || '—') + (L.city ? ', ' + L.city : '')),
            h('div', { style: { fontSize: '17px', fontWeight: 700, color: BLUE2, marginBottom: '6px' } },
              fmtINR(L.price_inr) + (L.transaction === 'rent' ? '/mo' : '')),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap',
              fontSize: '11px', color: '#64748b', marginBottom: '8px' } },
              L.bhk ? h('span', { style: chipStyle() }, L.bhk) : null,
              h('span', { style: chipStyle() }, num(L.carpet_sqft || L.super_sqft) + ' sqft'),
              L.floor ? h('span', { style: chipStyle() }, 'Floor ' + L.floor) : null,
              L.furnished ? h('span', { style: chipStyle() }, L.furnished) : null
            ),
            h('div', { style: { display: 'flex', gap: '5px', marginTop: '8px' } },
              actionBtn('🌐 Share', function (e) { e.stopPropagation(); shareListing(L); }),
              actionBtn('📄 PDF', function (e) { e.stopPropagation(); toast('Brochure PDF ships in Commit 2'); }),
              actionBtn('📱 WA', function (e) { e.stopPropagation(); shareWA(L); }),
              actionBtn('📊 Analytics', function (e) { e.stopPropagation(); openAnalytics(L); })
            )
          );
          card.appendChild(info);
          card.onmouseenter = function () { card.style.transform = 'translateY(-2px)';
            card.style.boxShadow = '0 4px 14px rgba(37,99,235,.15)'; };
          card.onmouseleave = function () { card.style.transform = 'translateY(0)';
            card.style.boxShadow = 'none'; };
          grid.appendChild(card);
        });
        wrap.appendChild(grid);
      }

      function chipStyle() { return { background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }; }
      function actionBtn(label, onclick) {
        return h('button', {
          style: { flex: 1, fontSize: '10.5px', padding: '5px 6px',
            border: '1px solid #dbeafe', background: '#fff', borderRadius: '5px',
            cursor: 'pointer', color: '#475569' },
          onclick: onclick
        }, label);
      }
      function iconForType(t) {
        return { residential: '🏙️', commercial: '🏢', plot: '🌳',
          villa: '🏘️', farmhouse: '🏞️', industrial: '🏭' }[t] || '🏠';
      }
      function statusPill(s) {
        const m = { available: 'ok', under_offer: 'warn', booked: 'amber',
          sold: 'bad', rented: 'bad', withdrawn: 'gray' };
        return pill(s, m[s] || 'gray');
      }
      function shareListing(L) {
        const url = window.location.origin + '/t/' + (window.TENANT_SLUG || 'me') + '/list/' + L.id;
        if (navigator.clipboard) navigator.clipboard.writeText(url);
        toast('Public link copied: ' + url);
        api('api_re_listing_analytics_track', { listing_id: L.id, event_kind: 'share',
          source: 'copy_link' }).catch(function () {});
      }
      function shareWA(L) {
        const url = window.location.origin + '/t/' + (window.TENANT_SLUG || 'me') + '/list/' + L.id;
        const msg = encodeURIComponent('Take a look at this property: ' + L.title + ' — ' + fmtINR(L.price_inr) + '\n' + url);
        window.open('https://wa.me/?text=' + msg, '_blank');
        api('api_re_listing_analytics_track', { listing_id: L.id, event_kind: 'share',
          source: 'wa' }).catch(function () {});
      }
      function openAnalytics(L) {
        try { window.location.hash = '#/repropertyanalytics?listing_id=' + L.id; } catch (_) {}
      }
      refresh();
    };

    async function openListingModal(L, onDone) {
      L = L || {};
      let amenities = [];
      try { const r = await api('api_re_amenities_list'); amenities = r.amenities || []; } catch (_) {}

      const m = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
        onclick: function (ev) { if (ev.target === m) m.remove(); } });
      const card = h('div', { style: { background: '#fff', borderRadius: '12px',
        width: '720px', maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
        padding: '20px 24px' } });
      card.appendChild(h('h3', { style: { margin: '0 0 4px' } },
        L.id ? '✏️ Edit Listing' : '🏘️ New Listing'));

      const F = {};
      function row(label, child, key) {
        if (key) F[key] = child;
        return h('div', { style: { display: 'grid',
          gridTemplateColumns: '160px 1fr', gap: '10px', padding: '8px 0',
          borderBottom: '1px solid #f1f5f9', alignItems: 'center' } },
          h('div', { style: { fontSize: '12.5px', color: '#475569', fontWeight: 600 } }, label),
          child);
      }
      function input(val, opts) {
        return h('input', Object.assign({
          value: val == null ? '' : String(val), type: 'text',
          style: { width: '100%', padding: '7px 9px', border: '1px solid #dbeafe',
            borderRadius: '7px', fontSize: '13px' }
        }, opts || {}));
      }
      function sel(val, choices) {
        const s = h('select', { style: { width: '100%', padding: '7px 9px',
          border: '1px solid #dbeafe', borderRadius: '7px', fontSize: '13px', background: '#fff' } });
        choices.forEach(function (c) {
          const v = Array.isArray(c) ? c[0] : c;
          const lbl = Array.isArray(c) ? c[1] : c;
          const o = h('option', { value: v }, lbl);
          if (v === val) o.selected = true;
          s.appendChild(o);
        });
        return s;
      }

      card.appendChild(row('Title', input(L.title, { placeholder: 'e.g. 3 BHK · 1850 sqft · Sea-facing' }), 'title'));
      card.appendChild(row('Type', sel(L.type || 'residential', [
        ['residential', 'Residential'], ['commercial', 'Commercial'],
        ['plot', 'Plot'], ['villa', 'Villa'], ['farmhouse', 'Farmhouse'], ['industrial', 'Industrial']
      ]), 'type'));
      card.appendChild(row('Transaction', sel(L.transaction || 'sale', [
        ['sale', 'Sale'], ['rent', 'Rent'], ['lease', 'Lease']
      ]), 'transaction'));
      card.appendChild(row('BHK', sel(L.bhk || '', [
        ['', '—'], ['1 BHK', '1 BHK'], ['2 BHK', '2 BHK'], ['3 BHK', '3 BHK'],
        ['4 BHK', '4 BHK'], ['5 BHK', '5+ BHK']
      ]), 'bhk'));
      card.appendChild(row('Carpet sqft', input(L.carpet_sqft, { type: 'number' }), 'carpet_sqft'));
      card.appendChild(row('Super sqft', input(L.super_sqft, { type: 'number' }), 'super_sqft'));
      card.appendChild(row('Floor / Total', h('div', { style: { display: 'flex', gap: '8px' } },
        Object.assign(input(L.floor, { type: 'number', placeholder: 'Floor' }), { _key: 'floor' }),
        Object.assign(input(L.total_floors, { type: 'number', placeholder: 'Total' }), { _key: 'total_floors' })
      )));
      // Track them
      F.floor = card.querySelector('input[placeholder="Floor"]');
      F.total_floors = card.querySelector('input[placeholder="Total"]');
      card.appendChild(row('Locality', input(L.locality, { placeholder: 'e.g. Bandra West' }), 'locality'));
      card.appendChild(row('City', input(L.city, { placeholder: 'Mumbai' }), 'city'));
      card.appendChild(row('Landmark', input(L.landmark), 'landmark'));
      card.appendChild(row('Price ₹', input(L.price_inr, { type: 'number', placeholder: '6800000 = ₹68 L' }), 'price_inr'));
      card.appendChild(row('Furnished', sel(L.furnished || 'unfurnished', [
        ['unfurnished', 'Unfurnished'], ['semi', 'Semi-furnished'], ['fully', 'Fully furnished']
      ]), 'furnished'));
      card.appendChild(row('Virtual Tour URL', input(L.virtual_tour_url,
        { placeholder: 'Matterport / Kuula / 360° URL' }), 'virtual_tour_url'));
      card.appendChild(row('Video Tour URL', input(L.video_tour_url,
        { placeholder: 'YouTube / Vimeo URL' }), 'video_tour_url'));
      card.appendChild(row('RERA #', input(L.rera_number), 'rera_number'));
      card.appendChild(row('Owner name', input(L.owner_name), 'owner_name'));
      card.appendChild(row('Owner phone', input(L.owner_phone), 'owner_phone'));
      card.appendChild(row('Status', sel(L.status || 'available', [
        ['available', 'Available'], ['under_offer', 'Under offer'],
        ['booked', 'Booked'], ['sold', 'Sold'], ['rented', 'Rented'], ['withdrawn', 'Withdrawn']
      ]), 'status'));

      const actions = h('div', { style: { display: 'flex', gap: '8px',
        marginTop: '14px', justifyContent: 'flex-end' } });
      actions.appendChild(btn('Cancel', function () { m.remove(); }));
      actions.appendChild(btn(L.id ? '💾 Save' : '➕ Create', async function () {
        const payload = { id: L.id || 0 };
        ['title','type','transaction','bhk','carpet_sqft','super_sqft','floor','total_floors',
         'locality','city','landmark','price_inr','furnished','virtual_tour_url','video_tour_url',
         'rera_number','owner_name','owner_phone','status'].forEach(function (k) {
          payload[k] = (F[k] && F[k].value) || null;
        });
        try {
          await api('api_re_listing_save', payload);
          toast(L.id ? 'Listing saved' : 'Listing created');
          m.remove();
          if (onDone) onDone();
        } catch (e) { toast(e.message); }
      }, 'primary'));
      card.appendChild(actions);
      m.appendChild(card);
      document.body.appendChild(m);
    }

    async function openListingDetail(L) {
      let data;
      try { data = await api('api_re_listing_get', { listing_id: L.id }); }
      catch (e) { toast(e.message); return; }
      const lst = data.listing || L;
      const ph = data.photos || [];
      const tr = data.tours || [];

      const m = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
        onclick: function (ev) { if (ev.target === m) m.remove(); } });
      const card = h('div', { style: { background: '#fff', borderRadius: '12px',
        width: '720px', maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
        padding: '20px 24px' } });
      card.appendChild(h('h3', { style: { margin: '0 0 4px' } }, lst.title));
      card.appendChild(h('div', { style: { fontSize: '13px', color: '#64748b', marginBottom: '14px' } },
        '📍 ' + (lst.locality || '—') + ' · ' + (lst.bhk || '') + ' · ' + num(lst.super_sqft || lst.carpet_sqft) + ' sqft · ' + fmtINR(lst.price_inr)));

      card.appendChild(h('div', { style: { display: 'flex', gap: '10px', marginBottom: '14px' } },
        kpiTile('Views', num(lst.view_count || 0), 'lifetime'),
        kpiTile('Enquiries', num(lst.enquiry_count || 0), 'lifetime'),
        kpiTile('Photos', num(ph.length), 'uploaded'),
        kpiTile('Tours', num(tr.length), 'attached')));

      if (lst.virtual_tour_url || lst.video_tour_url) {
        card.appendChild(h('div', { style: { padding: '10px', background: '#f1f5f9',
          borderRadius: '8px', marginBottom: '12px', fontSize: '13px' } },
          lst.virtual_tour_url ? h('div', {}, '🌐 Tour: ', h('a', { href: lst.virtual_tour_url, target: '_blank' }, lst.virtual_tour_url)) : null,
          lst.video_tour_url ? h('div', {}, '🎥 Video: ', h('a', { href: lst.video_tour_url, target: '_blank' }, lst.video_tour_url)) : null
        ));
      }

      const actions = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap',
        marginTop: '16px', justifyContent: 'space-between' } });
      const left = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
      left.appendChild(btn('✏️ Edit', function () { m.remove(); openListingModal(lst, null); }));
      left.appendChild(btn('📊 Analytics', function () { m.remove();
        try { window.location.hash = '#/repropertyanalytics?listing_id=' + lst.id; } catch (_) {} }));
      actions.appendChild(left);
      actions.appendChild(btn('Close', function () { m.remove(); }));
      card.appendChild(actions);
      m.appendChild(card); document.body.appendChild(m);
    }

    // ════════════════════════════════════════════════════════════════
    //  VIRTUAL TOURS (placeholder for Commit 2)
    // ════════════════════════════════════════════════════════════════
    VIEWS.revirtualtours = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Real Estate / Virtual Tours', '🎬 Virtual Tours', []));
      let data;
      try { data = await api('api_re_listing_list', { status: 'available' }); }
      catch (e) { view.appendChild(h('p', { style: { color: '#dc2626' } }, e.message)); return; }
      const withTours = (data.listings || []).filter(function (L) {
        return L.virtual_tour_url || L.video_tour_url || L.drone_url;
      });
      if (!withTours.length) {
        view.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
          background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px', color: '#64748b' } },
          'No tours yet. Edit a listing and paste a Matterport / Kuula / YouTube URL.'));
        return;
      }
      const grid = h('div', { style: { display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px' } });
      withTours.forEach(function (L) {
        const kind = L.virtual_tour_url ? '🌐 360°' : L.video_tour_url ? '🎥 Video' : '🛰️ Drone';
        const url = L.virtual_tour_url || L.video_tour_url || L.drone_url;
        const card = h('div', {
          style: { background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px',
            overflow: 'hidden', cursor: 'pointer', transition: 'all .15s' },
          onclick: function () { window.open(url, '_blank'); }
        });
        card.appendChild(h('div', { style: { height: '140px',
          background: 'linear-gradient(135deg,#7c3aed,#ec4899)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '42px', position: 'relative' } },
          h('span', { style: { position: 'absolute', top: '6px', left: '6px',
            background: 'rgba(0,0,0,.7)', color: '#fff', fontSize: '9px',
            padding: '2px 6px', borderRadius: '99px', fontWeight: 700 } }, kind),
          '▶'
        ));
        card.appendChild(h('div', { style: { padding: '10px' } },
          h('b', { style: { fontSize: '12.5px' } }, L.title),
          h('div', { style: { fontSize: '11.5px', color: '#64748b', marginTop: '4px' } },
            '📍 ' + (L.locality || '—'))
        ));
        grid.appendChild(card);
      });
      view.appendChild(grid);
    };

    // ════════════════════════════════════════════════════════════════
    //  PROPERTY ANALYTICS — per-listing
    // ════════════════════════════════════════════════════════════════
    VIEWS.repropertyanalytics = async function (view) {
      view.innerHTML = '';
      let lid = null;
      try {
        const m = window.location.hash.match(/[?&]listing_id=(\d+)/);
        if (m) lid = Number(m[1]);
      } catch (_) {}

      view.appendChild(topbar('Real Estate / Property Analytics',
        '📊 Property Analytics', []));

      // If no listing selected, show picker
      if (!lid) {
        let listings = [];
        try { const r = await api('api_re_listing_list'); listings = r.listings || []; } catch (_) {}
        const sel = h('select', { style: { padding: '7px 10px', border: '1px solid #dbeafe',
          borderRadius: '7px', fontSize: '13px', minWidth: '350px', background: '#fff' },
          onchange: function () { window.location.hash = '#/repropertyanalytics?listing_id=' + sel.value; }
        });
        sel.appendChild(h('option', { value: '' }, 'Pick a listing…'));
        listings.forEach(function (L) {
          sel.appendChild(h('option', { value: L.id }, L.title + ' · ' + (L.locality || '—')));
        });
        view.appendChild(h('div', { style: { padding: '20px' } }, sel));
        return;
      }

      let data;
      try { data = await api('api_re_listing_analytics', { listing_id: lid }); }
      catch (e) { view.appendChild(h('p', { style: { color: '#dc2626' } }, e.message)); return; }
      const k = data.kpis || {};
      const L = data.listing || {};

      view.appendChild(h('div', { style: { padding: '10px 14px',
        background: '#eff6ff', borderRadius: '8px', marginBottom: '14px' } },
        h('b', {}, L.title), ' · 📍 ', L.locality || '—', ' · ', fmtINR(L.price_inr)));

      view.appendChild(h('div', { style: { display: 'flex', gap: '12px',
        flexWrap: 'wrap', marginBottom: '14px' } },
        kpiTile('Public link views', num(k.views || 0), 'lifetime'),
        kpiTile('Enquiries', num(k.enquiries || 0),
          k.views > 0 ? ((k.enquiries / k.views * 100).toFixed(1) + '% conv') : ''),
        kpiTile('Tour plays', num(k.tour_plays || 0), num(k.tour_completes || 0) + ' completed'),
        kpiTile('Shares', num(k.shares || 0), num(k.brochures || 0) + ' brochures DL')
      ));

      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } });
      // Source breakdown
      const srcCard = h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
        borderRadius: '10px', padding: '14px' } },
        h('h2', { style: { fontSize: '14px', margin: '0 0 10px' } }, '🥧 Enquiry Sources'));
      const total = (data.sources || []).reduce(function (s, x) { return s + Number(x.n || 0); }, 0);
      if (!total) srcCard.appendChild(h('p', { style: { fontSize: '12px', color: '#64748b' } },
        'No enquiries yet.'));
      else {
        const tbl = h('table', { style: { width: '100%', fontSize: '13px' } });
        (data.sources || []).forEach(function (s) {
          tbl.appendChild(h('tr', {},
            h('td', { style: { padding: '6px 0' } }, sourceLabel(s.source)),
            h('td', { style: { padding: '6px 0', textAlign: 'right' } }, h('b', {}, num(s.n))),
            h('td', { style: { padding: '6px 0', textAlign: 'right', color: '#64748b' } },
              Math.round(s.n / total * 100) + '%')
          ));
        });
        srcCard.appendChild(tbl);
      }
      grid.appendChild(srcCard);

      // Conversion funnel
      const funnelCard = h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
        borderRadius: '10px', padding: '14px' } },
        h('h2', { style: { fontSize: '14px', margin: '0 0 10px' } }, '🎯 Conversion Funnel'));
      const v = k.views || 0;
      const t = k.tour_plays || 0;
      const c = k.tour_completes || 0;
      const e = k.enquiries || 0;
      [
        ['Public link views', v, 100],
        ['Tour plays', t, v > 0 ? Math.round(t / v * 100) : 0],
        ['Tour completes', c, v > 0 ? Math.round(c / v * 100) : 0],
        ['Enquiries', e, v > 0 ? Math.round(e / v * 100) : 0]
      ].forEach(function (s, i) {
        const widthPct = Math.max(15, s[2]);
        const colors = ['#3b82f6','#6366f1','#a855f7','#16a34a'];
        funnelCard.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px',
          padding: '8px', background: colors[i], color: '#fff', borderRadius: '6px',
          marginBottom: '4px', width: widthPct + '%', minWidth: '200px', fontWeight: 600 } },
          h('b', {}, num(s[1])), ' ', s[0], ' (', s[2], '%)'));
      });
      grid.appendChild(funnelCard);
      view.appendChild(grid);

      function sourceLabel(s) {
        return { wa: '📱 WhatsApp', website: '🌐 Website', '99acres': '🏘️ 99acres',
          magicbricks: '🏠 Magicbricks', referral: '👥 Referral',
          direct: '🔗 Direct', fb: '📘 Facebook', google: '🔍 Google',
          copy_link: '📋 Copy link' }[s] || s;
      }
    };

    // ════════════════════════════════════════════════════════════════
    //  DEAL PIPELINE
    // ════════════════════════════════════════════════════════════════
    const DEAL_STAGES = [
      { seq: 1, label: 'Enquired',           color: '#6b7280' },
      { seq: 2, label: 'Visit Scheduled',    color: '#06b6d4' },
      { seq: 3, label: 'Visit Done',         color: '#3b82f6' },
      { seq: 4, label: 'Interested',         color: '#a855f7' },
      { seq: 5, label: 'Negotiation',        color: '#f59e0b' },
      { seq: 6, label: 'Offer Made',         color: '#f97316' },
      { seq: 7, label: 'Token Received',     color: '#dc2626' },
      { seq: 8, label: 'Sale Deed Done',     color: '#16a34a' }
    ];

    VIEWS.redealpipeline = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Real Estate / Deal Pipeline', '📊 Deal Pipeline', [
        btn('🔄 Refresh', refresh)
      ]));

      let mode = 'list';
      try { mode = localStorage.getItem('re_deal_view') || 'list'; } catch (_) {}
      const toggle = h('div', { style: { display: 'flex', background: '#dbeafe',
        padding: '3px', borderRadius: '8px', width: 'fit-content', marginBottom: '12px' } });
      ['list','kanban'].forEach(function (md) {
        const b = h('button', {
          style: tStyle(mode === md),
          onclick: function () { mode = md;
            try { localStorage.setItem('re_deal_view', md); } catch (_) {}
            Array.from(toggle.children).forEach(function (x, i) {
              Object.assign(x.style, tStyle(['list','kanban'][i] === md));
            });
            render(); }
        }, md === 'list' ? '📋 List' : '🗂 Kanban');
        toggle.appendChild(b);
      });
      function tStyle(on) {
        return { padding: '6px 14px', border: 0,
          background: on ? '#fff' : 'transparent',
          color: on ? BLUE2 : '#475569',
          borderRadius: '6px', fontSize: '12.5px', fontWeight: 600,
          cursor: 'pointer', boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none' };
      }
      view.appendChild(toggle);

      const wrap = h('div'); view.appendChild(wrap);
      let deals = [];
      async function refresh() {
        wrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        try { const r = await api('api_re_deal_list'); deals = r.deals || []; }
        catch (e) { wrap.innerHTML = ''; wrap.appendChild(h('div', { style: { color: '#dc2626', padding: '1rem' } }, e.message)); return; }
        render();
      }
      function render() {
        wrap.innerHTML = '';
        if (!deals.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px', color: '#64748b' } },
            'No deals yet. Deals are created when buyer interest is captured on a listing.'));
          return;
        }
        if (mode === 'list') renderList(); else renderKanban();
      }
      function renderList() {
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse',
          fontSize: '13px', background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px' } });
        tbl.appendChild(h('thead', {}, h('tr', { style: { background: '#eff6ff' } },
          ['Deal #','Buyer','Listing','Stage','Asking','Offer','Owner','Action'].map(function (l) {
            return h('th', { style: { textAlign: 'left', padding: '10px 12px',
              fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.4px',
              color: '#475569', fontWeight: 600, borderBottom: '1px solid #dbeafe' } }, l);
          })
        )));
        const tbody = h('tbody', {});
        deals.forEach(function (d) {
          const st = DEAL_STAGES[d.current_stage - 1] || DEAL_STAGES[0];
          tbody.appendChild(h('tr', {},
            td(h('b', {}, d.deal_no || ('#' + d.id))),
            td((d.lead_name || '—') + (d.lead_phone ? ' · ' + d.lead_phone : '')),
            td(d.listing_title || '—'),
            td(h('span', { style: { background: st.color, color: '#fff', padding: '3px 9px',
              borderRadius: '99px', fontSize: '11px', fontWeight: 700 } }, st.seq + '. ' + st.label)),
            td(fmtINR(d.asking_price)),
            td(d.offer_price ? fmtINR(d.offer_price) : '—'),
            td(d.owner_name || '—'),
            td(d.current_stage < 8
              ? h('button', { style: { background: 'linear-gradient(135deg,#3b82f6,#2563eb)',
                color: '#fff', border: 0, padding: '4px 10px', borderRadius: '6px',
                fontSize: '11.5px', fontWeight: 700, cursor: 'pointer' },
                onclick: async function () {
                  try { await api('api_re_deal_advance', { deal_id: d.id });
                    toast('Advanced'); refresh();
                  } catch (e) { toast(e.message); }
                } }, '⬆ Advance')
              : pill('✓ Closed', 'ok')
            )
          ));
        });
        tbl.appendChild(tbody);
        wrap.appendChild(tbl);
      }
      function td(content) {
        const c = h('td', { style: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9' } });
        if (typeof content === 'object' && content && content.nodeType) c.appendChild(content);
        else c.textContent = String(content);
        return c;
      }
      function renderKanban() {
        const cols = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px' } });
        const cols2 = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px', marginTop: '8px' } });
        function col(s) {
          const sub = deals.filter(function (d) { return d.current_stage === s.seq; });
          const c = h('div', { style: { background: '#eff6ff', border: '1px solid #dbeafe',
            borderRadius: '10px', padding: '8px', minHeight: '220px' } });
          c.appendChild(h('h3', { style: { margin: '0 0 8px', fontSize: '11.5px',
            textTransform: 'uppercase', letterSpacing: '.4px', color: '#475569',
            display: 'flex', justifyContent: 'space-between' } },
            h('span', {}, s.seq + '. ' + s.label),
            h('span', { style: { background: s.color, color: '#fff',
              padding: '1px 7px', borderRadius: '99px', fontSize: '10px', fontWeight: 700 } }, String(sub.length))
          ));
          sub.forEach(function (d) {
            c.appendChild(h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
              borderRadius: '8px', padding: '9px', marginBottom: '6px', cursor: 'pointer' } },
              h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, d.lead_name || '—'),
              h('div', { style: { fontSize: '11px', color: '#64748b', margin: '3px 0' } },
                d.listing_title || '—'),
              h('div', { style: { fontSize: '11px', color: BLUE2, fontWeight: 700 } },
                fmtINR(d.asking_price))
            ));
          });
          return c;
        }
        [1,2,3,4].forEach(function (s) { cols.appendChild(col(DEAL_STAGES[s-1])); });
        [5,6,7,8].forEach(function (s) { cols2.appendChild(col(DEAL_STAGES[s-1])); });
        wrap.appendChild(cols); wrap.appendChild(cols2);
      }
      refresh();
    };

    // ════════════════════════════════════════════════════════════════
    //  MARKET INSIGHTS
    // ════════════════════════════════════════════════════════════════
    VIEWS.remarketinsights = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Real Estate / Market Insights', '📈 Market Insights', []));
      let data;
      try { data = await api('api_re_market_insights'); }
      catch (e) { view.appendChild(h('p', { style: { color: '#dc2626' } }, e.message)); return; }

      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } });

      const c1 = h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
        borderRadius: '10px', padding: '14px' } },
        h('h2', { style: { fontSize: '14px', margin: '0 0 10px' } }, '💰 Avg ₹/sqft per locality (90d)'));
      const psf = data.avg_per_sqft || [];
      if (!psf.length) c1.appendChild(h('p', { style: { fontSize: '12px', color: '#64748b' } },
        'Need 3+ listings per locality to compute. Add more listings first.'));
      else {
        const tbl = h('table', { style: { width: '100%', fontSize: '13px' } });
        psf.forEach(function (r) {
          tbl.appendChild(h('tr', {},
            h('td', { style: { padding: '6px 0' } }, r.locality),
            h('td', { style: { padding: '6px 0', color: '#64748b' } }, r.listings + ' listings'),
            h('td', { style: { padding: '6px 0', textAlign: 'right', fontWeight: 700, color: BLUE2 } },
              '₹' + Math.round(Number(r.avg_psqft)).toLocaleString('en-IN') + ' /sqft')
          ));
        });
        c1.appendChild(tbl);
      }
      grid.appendChild(c1);

      const c2 = h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
        borderRadius: '10px', padding: '14px' } },
        h('h2', { style: { fontSize: '14px', margin: '0 0 10px' } }, '🔥 Hot Localities (7d enquiries)'));
      const hot = data.hot_localities || [];
      if (!hot.length) c2.appendChild(h('p', { style: { fontSize: '12px', color: '#64748b' } },
        'No enquiries this week.'));
      else {
        const tbl = h('table', { style: { width: '100%', fontSize: '13px' } });
        hot.forEach(function (r) {
          tbl.appendChild(h('tr', {},
            h('td', { style: { padding: '6px 0' } }, r.locality),
            h('td', { style: { padding: '6px 0', textAlign: 'right', fontWeight: 700 } }, num(r.enquiries) + ' enq')
          ));
        });
        c2.appendChild(tbl);
      }
      grid.appendChild(c2);

      view.appendChild(grid);

      const ttc = data.time_to_close || [];
      if (ttc.length) {
        const c3 = h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
          borderRadius: '10px', padding: '14px', marginTop: '12px' } },
          h('h2', { style: { fontSize: '14px', margin: '0 0 10px' } }, '⏱️ Avg time-to-close by type'));
        const tbl = h('table', { style: { width: '100%', fontSize: '13px' } });
        ttc.forEach(function (r) {
          tbl.appendChild(h('tr', {},
            h('td', { style: { padding: '6px 0' } }, r.type),
            h('td', { style: { padding: '6px 0', textAlign: 'right', fontWeight: 700 } }, r.avg_days + ' days')
          ));
        });
        c3.appendChild(tbl);
        view.appendChild(c3);
      }

      view.appendChild(h('p', { style: { fontSize: '11px', color: '#94a3b8', marginTop: '14px' } },
        'Data computed from your tenant\'s own listings + deals. External data (99acres / Magicbricks / Knight Frank) comes in Phase 3.'));
    };

    // ════════════════════════════════════════════════════════════════
    //  REMOTE TOOLS
    // ════════════════════════════════════════════════════════════════
    VIEWS.reremotetools = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Real Estate / Remote Tools', '🔧 Remote Tools', []));
      view.appendChild(h('p', { style: { color: '#64748b', fontSize: '12.5px', marginBottom: '14px' } },
        'Operations + closing tools that work without physical site visits.'));

      const tools = [
        { icon: '📅', title: 'Remote Site Visit Booking', desc: 'Public link clients open from WA → pick slot → auto-creates calendar event.' },
        { icon: '🎥', title: 'Live Video Tour', desc: 'Schedule WA video call slots; one-click "Start tour".' },
        { icon: '📝', title: 'e-Sign Documents', desc: 'DocuSign / Zoho Sign integration. Track signature status.', status: 'Setup required' },
        { icon: '💰', title: 'Remote Token Payment', desc: 'One-click Razorpay/Cashfree link → auto-record in deal.' },
        { icon: '🎬', title: 'Recorded Tour Library', desc: 'Reusable tour videos. Send same link to many leads.' },
        { icon: '✍️', title: 'Digital Offer Form', desc: 'Client fills offer via public link → creates deal in "Offer Made".' },
        { icon: '💬', title: 'RE WhatsApp Templates', desc: '12 pre-seeded templates (listing share, visit confirm, token, etc).', status: '12 templates ready' }
      ];
      const grid = h('div', { style: { display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' } });
      tools.forEach(function (t) {
        const c = h('div', { style: { background: '#fff', border: '1px solid #dbeafe',
          borderRadius: '10px', padding: '16px', cursor: 'pointer' },
          onclick: function () { toast(t.title + ' — full UI ships in Commit 3'); }
        },
          h('div', { style: { fontSize: '32px', marginBottom: '8px' } }, t.icon),
          h('h3', { style: { margin: '0 0 4px', fontSize: '14px' } }, t.title),
          h('p', { style: { margin: '0 0 8px', fontSize: '12px', color: '#64748b' } }, t.desc),
          t.status ? pill(t.status, 'info') : pill('Configure →', 'gray')
        );
        grid.appendChild(c);
      });
      view.appendChild(grid);
    };

    // ════════════════════════════════════════════════════════════════
    //  DOCUMENTS
    // ════════════════════════════════════════════════════════════════
    VIEWS.redocuments = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Real Estate / Documents', '📁 Document Vault', [
        btn('+ Upload', function () { toast('Upload UI ships in Commit 4'); }, 'primary')
      ]));
      let data;
      try { data = await api('api_re_documents_list'); }
      catch (e) { view.appendChild(h('p', { style: { color: '#dc2626' } }, e.message)); return; }
      const docs = data.documents || [];
      if (!docs.length) {
        view.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
          background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px', color: '#64748b' } },
          'No documents yet. Categories: Sale Deed, RERA, OC, NOC, Encumbrance Cert, Token Receipt, Booking Form, PAN, Aadhaar, Loan Sanction.'));
        return;
      }
      const tbl = h('table', { style: { width: '100%', fontSize: '13px',
        background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px', borderCollapse: 'collapse' } });
      docs.forEach(function (d) {
        tbl.appendChild(h('tr', {},
          h('td', { style: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9' } }, '📄'),
          h('td', { style: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9' } },
            h('b', {}, d.title),
            h('div', { style: { fontSize: '11px', color: '#64748b' } },
              (d.category || '—') + ' · ' + (d.size_kb || 0) + ' KB'))
        ));
      });
      view.appendChild(tbl);
    };

    // ════════════════════════════════════════════════════════════════
    //  AI INSIGHTS
    // ════════════════════════════════════════════════════════════════
    VIEWS.reaiinsights = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Real Estate / AI Insights', '🤖 AI Insights', []));

      // Build rule-based insights from summary + market
      let summary = {}, market = {};
      try { summary = await api('api_re_summary_v2'); } catch (_) {}
      try { market = await api('api_re_market_insights'); } catch (_) {}

      const insights = [];
      const l = summary.listings || {};
      const d = summary.deals || {};

      if ((summary.enquiries_this_week || 0) > 0) {
        insights.push({ type: 'growth', emoji: '📈',
          headline: summary.enquiries_this_week + ' enquiries this week',
          detail: 'Trend is strong. Make sure agents respond within 1 hour for max conversion.',
          action: 'Open WA Inbox' });
      }
      if ((l.with_tours || 0) < (l.active_listings || 0) * 0.4) {
        insights.push({ type: 'suggest', emoji: '🎬',
          headline: Math.max(0, (l.active_listings || 0) - (l.with_tours || 0)) + ' listings have NO virtual tour',
          detail: 'Listings with tours get 3.2× more enquiries. Even a 1-min phone video helps.',
          action: 'Edit listings + paste YouTube URL' });
      }
      if ((d.in_negotiation || 0) > 5) {
        insights.push({ type: 'warning', emoji: '⚠️',
          headline: d.in_negotiation + ' deals in Negotiation',
          detail: 'Avg deal time in this stage is 5d. Anything older has high cancel risk.',
          action: 'Review Deal Pipeline → Negotiation column' });
      }
      const hot = market.hot_localities || [];
      if (hot.length) {
        insights.push({ type: 'trend', emoji: '🔥',
          headline: hot[0].locality + ' is the hot locality this week',
          detail: hot[0].enquiries + ' enquiries. Push listings here for best conversion.',
          action: 'Open Listings → filter by ' + hot[0].locality });
      }
      insights.push({ type: 'trend', emoji: '🤖',
        headline: 'Gemini-powered weekly digest ships v1.2',
        detail: 'Predictive lead scoring + natural-language Q&A on your portfolio.',
        action: 'Available when COPILOT_PROACTIVE flag flips' });

      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } });
      const border = { growth: '#10b981', warning: '#dc2626', suggest: '#a855f7', trend: '#0ea5e9' };
      insights.forEach(function (ins) {
        grid.appendChild(h('div', { style: {
          background: '#fff', border: '1px solid #dbeafe', borderRadius: '10px',
          padding: '14px', borderLeft: '4px solid ' + (border[ins.type] || BLUE)
        } },
          h('div', { style: { fontSize: '22px', float: 'left', marginRight: '8px' } }, ins.emoji),
          h('div', { style: { fontWeight: 700, marginBottom: '3px' } }, ins.headline),
          h('div', { style: { fontSize: '12.5px', color: '#475569' } }, ins.detail),
          h('div', { style: { marginTop: '8px', fontSize: '12px', fontWeight: 600,
            borderTop: '1px solid #dbeafe', paddingTop: '6px', color: BLUE2 } },
            '→ ' + ins.action)
        ));
      });
      view.appendChild(grid);
    };

    console.log('[RE_PACK_v2] views wired: relistings, revirtualtours, repropertyanalytics, redealpipeline, reremotetools, redocuments, remarketinsights, reaiinsights');
  });
})();
