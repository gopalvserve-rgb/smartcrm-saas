/* ============================================================================
 * SOLAR_PACK_v1 — isolated SPA module (2026-06-27)
 *
 * Loaded by public/tenant/index.html as a second <script> after app.js.
 * All Solar pack VIEWS live here so app.js never grows.
 *
 * What's inside:
 *   - VIEWS.packsolar      (Overview — KPI dashboard)
 *   - VIEWS.solarsites     (Site Survey — list + edit form)
 *   - VIEWS.solarcalc      (Pricing Calculator — live calc)
 *   - VIEWS.solarquotes    (Quotes & Proposals — list + BOM editor)
 *   - VIEWS.solarinstalls  (Installation Tracker — List + Kanban + Timeline)
 *   - VIEWS.solarsubsidies (placeholder — Commit 3 will fill in)
 *   - VIEWS.solaramc       (placeholder — Commit 3)
 *   - VIEWS.solarinsights  (placeholder — Commit 3)
 *
 * Backend APIs lived in routes/packs/solar.js
 * ============================================================================ */

(function () {
  'use strict';

  // Wait for app.js to finish booting (it exposes window.api, h, etc.)
  function ready(fn) {
    if (window.VIEWS && window.api && window.h) return fn();
    setTimeout(() => ready(fn), 60);
  }

  ready(function () {
    const VIEWS = window.VIEWS;
    const api   = window.api;
    const h     = window.h;
    const toast = window.toast || function (m) { console.log(m); };

    // ── Solar-themed mini helpers ────────────────────────────────────
    const SOLAR_AMBER  = '#f59e0b';
    const SOLAR_AMBER2 = '#d97706';
    const SOLAR_BG     = '#fffbeb';

    function fmtINR(n) {
      const v = Number(n || 0);
      if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2) + ' Cr';
      if (v >= 100000)   return '₹' + (v / 100000).toFixed(2) + ' L';
      return '₹' + Math.round(v).toLocaleString('en-IN');
    }
    function fmtINRfull(n) { return '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN'); }
    function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

    function kpiTile(label, val, sub, color) {
      color = color || SOLAR_AMBER;
      return h('div', { style: {
        background: '#fff', border: '1px solid #fde68a', borderRadius: '10px',
        padding: '12px 14px', minWidth: '140px', flex: '1', position: 'relative',
        overflow: 'hidden', borderTop: '3px solid ' + color
      } },
        h('div', { style: { fontSize: '11px', color: '#78716c', textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600 } }, label),
        h('div', { style: { fontSize: '22px', fontWeight: 700, marginTop: '4px', color: '#1c1917' } }, String(val)),
        h('div', { style: { fontSize: '11.5px', marginTop: '4px', color: '#78716c' } }, sub || '')
      );
    }

    function pill(text, kind) {
      const map = {
        ok:     { bg: '#ecfdf5', fg: '#15803d' },
        warn:   { bg: '#fffbeb', fg: '#b45309' },
        bad:    { bg: '#fef2f2', fg: '#dc2626' },
        info:   { bg: '#eff6ff', fg: '#1d4ed8' },
        purple: { bg: '#faf5ff', fg: '#7e22ce' },
        gray:   { bg: '#f5f5f4', fg: '#57534e' },
        amber:  { bg: '#fef3c7', fg: '#92400e' }
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
        ? { background: 'linear-gradient(135deg,#fbbf24,#d97706)', color: '#1c1917',
            border: 0, padding: '7px 12px', borderRadius: '7px', fontWeight: 600,
            fontSize: '12.5px', cursor: 'pointer' }
        : { background: '#fff', border: '1px solid #fde68a', color: '#1c1917',
            padding: '7px 12px', borderRadius: '7px', fontWeight: 600,
            fontSize: '12.5px', cursor: 'pointer' };
      return h('button', { style, onclick }, label);
    }

    function topbar(crumb, title, actions) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '14px', paddingBottom: '12px',
        borderBottom: '1px solid #fde68a' } },
        h('div', {},
          h('div', { style: { fontSize: '12px', color: '#78716c' } }, crumb),
          h('h1', { style: { fontSize: '20px', margin: '4px 0 0' } }, title)
        ),
        h('div', { style: { display: 'flex', gap: '6px' } }, ...(actions || []))
      );
    }

    // Standard date filter (per pack_design_standard_v1)
    function dateFilter(stateKey, onChange) {
      const opts = [
        ['today',     'Today'],
        ['yesterday', 'Yesterday'],
        ['7d',        'Last 7d'],
        ['30d',       'Last 30d'],
        ['mtd',       'This month'],
        ['qtd',       'This quarter'],
        ['custom',    'Custom…']
      ];
      let stored = 'mtd';
      try { stored = localStorage.getItem('solar_df_' + stateKey) || 'mtd'; } catch (_) {}

      const seg = h('div', { style: { display: 'flex', background: '#fef3c7',
        padding: '3px', borderRadius: '8px', width: 'fit-content' } });

      opts.forEach(([code, label]) => {
        const isOn = code === stored;
        const b = h('button', {
          style: {
            padding: '6px 10px', border: 0,
            background: isOn ? '#fff' : 'transparent',
            color: isOn ? SOLAR_AMBER2 : '#78716c',
            borderRadius: '6px', fontSize: '12px', fontWeight: 600,
            cursor: 'pointer', boxShadow: isOn ? '0 1px 2px rgba(0,0,0,.06)' : 'none'
          },
          onclick: () => {
            try { localStorage.setItem('solar_df_' + stateKey, code); } catch (_) {}
            if (onChange) onChange(code);
          }
        }, label);
        seg.appendChild(b);
      });
      return seg;
    }

    // ════════════════════════════════════════════════════════════════
    //  OVERVIEW — KPI dashboard
    // ════════════════════════════════════════════════════════════════
    VIEWS.packsolar = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / Overview', '☀️ Solar Overview', [
        btn('🌱 Seed Demo Data', async function () {
          if (!confirm('Insert ~30 surveys, 18 quotes, 12 installs, 8 subsidies, 5 AMC visits?')) return;
          try { const r = await api('api_solar_seedDemo');
            if (r.skipped) { toast('Demo data already present'); }
            else if (r.ok) { toast('✓ Seeded · refreshing'); setTimeout(function(){ window.location.reload(); }, 800); }
          } catch (e) { toast('Seed failed: ' + e.message); }
        }),
        btn('+ New Lead', function () { try { window.location.hash = '#/leadnew'; } catch (_) {} }, 'primary')
      ]));

      // Date filter
      const dfWrap = h('div', { style: { marginBottom: '12px' } });
      dfWrap.appendChild(dateFilter('overview', function (_code) { /* future: re-fetch range */ }));
      view.appendChild(dfWrap);

      let s;
      try { s = await api('api_solar_summary'); }
      catch (e) {
        view.appendChild(h('p', { class: 'muted' }, 'Could not load summary: ' + e.message));
        return;
      }
      const sites = s.sites || {}, quotes = s.quotes || {}, ins = s.installs || {},
            sub = s.subsidy || {}, amc = s.amc || {};

      view.appendChild(h('div', { style: { display: 'flex', gap: '12px',
        flexWrap: 'wrap', marginBottom: '16px' } },
        kpiTile('Sites Surveyed', String(sites.surveyed_month || 0),
          (sites.sites_total || 0) + ' lifetime'),
        kpiTile('Quotes Sent', String(quotes.quotes_sent || 0),
          fmtINR(quotes.quotes_value || 0)),
        kpiTile('Conversion %', (s.conversion_pct || 0) + '%',
          'quotes → bookings'),
        kpiTile('In Installation', String(ins.active_installs || 0),
          Number(ins.active_kw || 0).toFixed(1) + ' kW'),
        kpiTile('Commissioned (mo)', String(ins.commissioned_month || 0),
          Number(ins.commissioned_month_kw || 0).toFixed(1) + ' kW · ' + fmtINR(ins.commissioned_month_inr || 0),
          '#10b981'),
        kpiTile('Subsidy Disbursed', fmtINR(sub.disbursed_amount || 0),
          (sub.disbursed_count || 0) + ' projects', '#10b981'),
        kpiTile('Subsidy Pending', fmtINR(sub.pending_amount || 0),
          (sub.pending_count || 0) + ' · ' + (sub.pending_oldest_days || 0) + 'd oldest',
          '#dc2626'),
        kpiTile('AMC Due (30d)', String(amc.amc_due_30d || 0),
          (amc.amc_overdue || 0) + ' overdue', '#dc2626')
      ));

      // Quick links
      const links = h('div', { style: { display: 'grid',
        gridTemplateColumns: 'repeat(4,1fr)', gap: '10px' } });
      const linkCard = function (icon, label, hash) {
        const c = h('div', {
          style: { background: '#fff', border: '1px solid #fde68a',
            borderRadius: '10px', padding: '14px', cursor: 'pointer',
            textAlign: 'center', transition: 'all .15s' },
          onclick: function () { try { window.location.hash = hash; } catch (_) {} }
        },
          h('div', { style: { fontSize: '28px' } }, icon),
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginTop: '4px' } }, label)
        );
        c.onmouseenter = function () { c.style.background = '#fffbeb'; };
        c.onmouseleave = function () { c.style.background = '#fff'; };
        return c;
      };
      links.appendChild(linkCard('🏠', 'Site Survey', '#/solarsites'));
      links.appendChild(linkCard('💰', 'Pricing Calculator', '#/solarcalc'));
      links.appendChild(linkCard('📄', 'Quotes & Proposals', '#/solarquotes'));
      links.appendChild(linkCard('🔧', 'Installation Tracker', '#/solarinstalls'));
      view.appendChild(links);

      view.appendChild(h('p', { class: 'muted',
        style: { fontSize: '.85rem', marginTop: '18px' } },
        'Subsidy Tracker (PM-Surya Ghar), AMC Scheduler and AI Insights ship in v1.1.'));
    };

    // ════════════════════════════════════════════════════════════════
    //  SITE SURVEY — list + edit form
    // ════════════════════════════════════════════════════════════════
    VIEWS.solarsites = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / Site Survey', '🏠 Site Surveys', [
        btn('+ New Survey', function () { openSiteSurveyModal(null, refresh); }, 'primary')
      ]));

      const toolbar = h('div', { style: { display: 'flex', gap: '8px',
        alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } });
      const search = h('input', { placeholder: '🔍 Search address / state / DISCOM',
        style: { minWidth: '260px', padding: '7px 10px', border: '1px solid #fde68a',
          borderRadius: '7px', fontSize: '13px' } });
      const refreshBtn = btn('🔄 Refresh', function () { refresh(); });
      toolbar.appendChild(search);
      toolbar.appendChild(refreshBtn);
      view.appendChild(toolbar);

      const tblWrap = h('div', { style: { background: '#fff', border: '1px solid #fde68a',
        borderRadius: '10px', overflow: 'hidden' } });
      view.appendChild(tblWrap);

      let _t;
      search.addEventListener('input', function () {
        clearTimeout(_t); _t = setTimeout(refresh, 250);
      });

      async function refresh() {
        tblWrap.innerHTML = '<div style="padding:1rem;color:#78716c">Loading…</div>';
        let data;
        try { data = await api('api_solar_site_list',
          { search: search.value || '', limit: 200 }); }
        catch (e) {
          tblWrap.innerHTML = '';
          tblWrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } },
            'Failed: ' + e.message));
          return;
        }
        tblWrap.innerHTML = '';
        if (!data.sites || !data.sites.length) {
          tblWrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            color: '#78716c' } }, 'No site surveys yet — click "+ New Survey" to add one.'));
          return;
        }
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse',
          fontSize: '13px' } });
        tbl.appendChild(h('thead', {}, h('tr', {
          style: { background: '#fffbeb', fontSize: '11.5px', textTransform: 'uppercase',
            letterSpacing: '.4px', color: '#78716c' }
        },
          ['Lead', 'Address', 'Roof', 'Bill/mo', 'kW rec.', 'DISCOM', 'Status', '']
            .map(function (l) { return h('th', { style: { textAlign: 'left',
              padding: '10px 12px', borderBottom: '1px solid #fde68a' } }, l); })
        )));
        const tbody = h('tbody', {});
        (data.sites || []).forEach(function (s) {
          const tr = h('tr', { style: { cursor: 'pointer' },
            onclick: function () { openSiteSurveyModal(s, refresh); } },
            h('td', { style: tdStyle() }, s.lead_name || '—'),
            h('td', { style: tdStyle() }, (s.address || '—') + (s.state ? ', ' + s.state : '')),
            h('td', { style: tdStyle() }, num(s.rooftop_area_sqft || 0) + (s.roof_type ? ' ' + s.roof_type : '')),
            h('td', { style: tdStyle() }, fmtINR(s.monthly_bill_inr || 0)),
            h('td', { style: tdStyle() },
              s.kw_recommended ? pill(Number(s.kw_recommended).toFixed(1) + ' kW', 'amber') : '—'),
            h('td', { style: tdStyle() }, s.discom || '—'),
            h('td', { style: tdStyle() },
              s.survey_done ? pill('Done ✓', 'ok') : pill('Pending', 'warn')),
            h('td', { style: tdStyle() }, pill('Edit', 'info'))
          );
          tr.onmouseenter = function () { tr.style.background = '#fffbeb'; };
          tr.onmouseleave = function () { tr.style.background = '#fff'; };
          tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        tblWrap.appendChild(tbl);
      }

      function tdStyle() {
        return { padding: '10px 12px', borderBottom: '1px solid #fef3c7' };
      }

      refresh();
    };

    function openSiteSurveyModal(site, onDone) {
      site = site || {};
      const m = h('div', { class: 'modal-backdrop',
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
        onclick: function (ev) { if (ev.target === m) m.remove(); }
      });
      const card = h('div', { style: { background: '#fff', borderRadius: '12px',
        width: '640px', maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
        padding: '18px 22px', boxShadow: '0 20px 60px rgba(0,0,0,.3)' } });

      card.appendChild(h('h3', { style: { margin: '0 0 4px' } },
        site.id ? '🏠 Edit Site Survey' : '🏠 New Site Survey'));
      card.appendChild(h('div', { style: { fontSize: '12px', color: '#78716c', marginBottom: '14px' } },
        'Mobile-friendly · GPS · Photo capture · Auto-calc kW'));

      const F = {};
      function row(label, child, key) {
        if (key) F[key] = child;
        return h('div', { style: { display: 'grid',
          gridTemplateColumns: '160px 1fr', gap: '10px', padding: '8px 0',
          borderBottom: '1px solid #fef3c7', alignItems: 'center' } },
          h('div', { style: { fontSize: '12.5px', color: '#57534e', fontWeight: 600 } }, label),
          child);
      }
      function input(val, opts) {
        opts = opts || {};
        return h('input', Object.assign({
          value: val == null ? '' : String(val),
          type: opts.type || 'text',
          style: { width: '100%', padding: '7px 9px', border: '1px solid #fde68a',
            borderRadius: '7px', fontSize: '13px' }
        }, opts));
      }
      function sel(val, choices) {
        const s = h('select', { style: { width: '100%', padding: '7px 9px',
          border: '1px solid #fde68a', borderRadius: '7px', fontSize: '13px',
          background: '#fff' } });
        choices.forEach(function (c) {
          const v = Array.isArray(c) ? c[0] : c;
          const lbl = Array.isArray(c) ? c[1] : c;
          const o = h('option', { value: v }, lbl);
          if (v === val) o.selected = true;
          s.appendChild(o);
        });
        return s;
      }

      card.appendChild(row('Lead ID', input(site.lead_id, { placeholder: 'lead id (optional)' }), 'lead_id'));
      card.appendChild(row('Address', input(site.address, { placeholder: 'Street, locality' }), 'address'));
      card.appendChild(row('State', sel(site.state || 'BR', [
        ['BR', 'Bihar'], ['UP', 'UP'], ['MH', 'Maharashtra'], ['GJ', 'Gujarat'],
        ['HR', 'Haryana'], ['DL', 'Delhi'], ['KA', 'Karnataka'], ['TS', 'Telangana'],
        ['TN', 'Tamil Nadu'], ['WB', 'WB']
      ]), 'state'));
      card.appendChild(row('Rooftop area (sqft)', input(site.rooftop_area_sqft, { type: 'number' }), 'rooftop_area_sqft'));
      card.appendChild(row('Roof type', sel(site.roof_type || 'rcc', [
        ['rcc', 'RCC'], ['metal', 'Metal sheet'], ['tiled', 'Tiled'], ['elevated', 'Elevated']
      ]), 'roof_type'));
      card.appendChild(row('Shadow %', input(site.shadow_pct || 0, { type: 'number', min: 0, max: 100 }), 'shadow_pct'));
      card.appendChild(row('Monthly bill ₹', input(site.monthly_bill_inr, { type: 'number' }), 'monthly_bill_inr'));
      card.appendChild(row('Sanctioned load (kW)', input(site.sanctioned_load_kw, { type: 'number', step: '0.5' }), 'sanctioned_load_kw'));
      card.appendChild(row('DISCOM', sel(site.discom || '', [
        ['', '—'], ['BSEB', 'BSEB (Bihar)'], ['BSES', 'BSES Delhi'],
        ['Tata Power', 'Tata Power Delhi'], ['MSEDCL', 'MSEDCL (Maharashtra)'],
        ['BESCOM', 'BESCOM (Karnataka)'], ['UGVCL', 'UGVCL (Gujarat)'],
        ['TSSPDCL', 'TSSPDCL (Telangana)'], ['Other', 'Other']
      ]), 'discom'));
      card.appendChild(row('Consumer category', sel(site.consumer_category || 'domestic', [
        ['domestic', 'Domestic'], ['commercial', 'Commercial'], ['industrial', 'Industrial']
      ]), 'consumer_category'));
      card.appendChild(row('Meter type', sel(site.meter_type || 'single_phase', [
        ['single_phase', 'Single phase'], ['three_phase', 'Three phase']
      ]), 'meter_type'));
      card.appendChild(row('Notes', h('textarea', { style: { width: '100%',
        padding: '7px 9px', border: '1px solid #fde68a', borderRadius: '7px',
        fontSize: '13px', fontFamily: 'inherit', minHeight: '60px' } }, site.notes || ''), 'notes'));

      const surveyDone = h('input', { type: 'checkbox',
        style: { transform: 'scale(1.2)' } });
      if (site.survey_done) surveyDone.checked = true;
      card.appendChild(row('Survey done?', surveyDone, 'survey_done'));

      // Actions
      const actions = h('div', { style: { display: 'flex', gap: '8px',
        marginTop: '16px', justifyContent: 'flex-end' } });
      actions.appendChild(btn('Cancel', function () { m.remove(); }));
      actions.appendChild(btn(site.id ? '💾 Save' : '➕ Create', async function () {
        const payload = {
          id:      site.id || 0,
          lead_id: Number(F.lead_id.value || 0) || null,
          address: F.address.value || null,
          state:   F.state.value || null,
          rooftop_area_sqft: Number(F.rooftop_area_sqft.value || 0) || null,
          roof_type: F.roof_type.value || null,
          shadow_pct: Number(F.shadow_pct.value || 0),
          monthly_bill_inr: Number(F.monthly_bill_inr.value || 0) || null,
          sanctioned_load_kw: Number(F.sanctioned_load_kw.value || 0) || null,
          discom: F.discom.value || null,
          consumer_category: F.consumer_category.value || 'domestic',
          meter_type: F.meter_type.value || null,
          notes: F.notes.value || null,
          survey_done: F.survey_done.checked ? 1 : 0
        };
        try {
          await api('api_solar_site_upsert', payload);
          toast('Site survey saved ✓');
          m.remove();
          if (onDone) onDone();
        } catch (e) { toast(e.message); }
      }, 'primary'));
      card.appendChild(actions);

      m.appendChild(card);
      document.body.appendChild(m);
    }

    // ════════════════════════════════════════════════════════════════
    //  PRICING CALCULATOR
    // ════════════════════════════════════════════════════════════════
    VIEWS.solarcalc = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / Pricing Calculator', '💰 Pricing Calculator', [
        btn('💾 Save as Quote', function () { saveAsQuote(); }, 'primary')
      ]));

      // Load config defaults
      let cfg = null;
      try { const r = await api('api_solar_pricing_config_get'); cfg = (r && r.config) || null; }
      catch (_) {}
      const panelRates = (cfg && cfg.panel_rates) || {
        mono_perc_tier1: 38, mono_perc_tier2: 32,
        poly_tier1: 30, topcon_tier1: 42, bifacial: 45
      };

      const S = {
        kw: 5,
        panel_tier: 'mono_perc_tier1',
        rate_per_w: panelRates.mono_perc_tier1 || 38,
        inverter_inr: 38000,
        battery_inr: 0,
        state: 'BR',
        shadow_pct: 15,
        tariff: (cfg && cfg.default_tariff_kwh) || 7.5,
        gst_pct: (cfg && cfg.default_gst_pct) || 13.8,
        emi_years: (cfg && cfg.default_emi_years) || 7,
        emi_rate: (cfg && cfg.default_emi_rate_pct) || 9.5
      };

      const grid = h('div', { style: { display: 'grid',
        gridTemplateColumns: '1fr 1fr', gap: '14px' } });

      // ─── Left column: inputs ──────────────────────────────────────
      const left = h('div', { style: { background: SOLAR_BG,
        border: '1px solid #fde68a', borderRadius: '10px', padding: '16px' } });
      left.appendChild(h('h3', { style: { margin: '0 0 12px' } }, '⚙️ Inputs'));

      function inputRow(label, child) {
        return h('div', { style: { display: 'grid',
          gridTemplateColumns: '140px 1fr', gap: '10px',
          padding: '8px 0', borderBottom: '1px solid #fef3c7',
          alignItems: 'center' } },
          h('div', { style: { fontSize: '12.5px', color: '#57534e', fontWeight: 600 } }, label),
          child);
      }

      // kW slider
      const kwLabel = h('b', { style: { color: SOLAR_AMBER2, fontSize: '15px' } }, S.kw + ' kW');
      const kwSlider = h('input', {
        type: 'range', min: '1', max: '100', value: String(S.kw),
        style: { width: '100%', accentColor: SOLAR_AMBER },
        oninput: function (ev) {
          S.kw = Number(ev.target.value);
          kwLabel.textContent = S.kw + ' kW';
          recalc();
        }
      });
      left.appendChild(inputRow('System size',
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          kwLabel, kwSlider)));

      // panel tier
      const tierSel = h('select', { style: inputStyle(),
        onchange: function (ev) {
          S.panel_tier = ev.target.value;
          S.rate_per_w = panelRates[S.panel_tier] || 38;
          rateLabel.textContent = '₹' + S.rate_per_w + '/W';
          recalc();
        }
      });
      Object.keys(panelRates).forEach(function (k) {
        const o = h('option', { value: k }, k.replace(/_/g, ' '));
        if (k === S.panel_tier) o.selected = true;
        tierSel.appendChild(o);
      });
      const rateLabel = h('span', { style: { fontSize: '12px',
        color: '#78716c', marginLeft: '8px' } }, '₹' + S.rate_per_w + '/W');
      left.appendChild(inputRow('Panel tier',
        h('div', { style: { display: 'flex', alignItems: 'center' } }, tierSel, rateLabel)));

      // inverter
      const invInput = h('input', { type: 'number',
        value: String(S.inverter_inr), style: inputStyle(),
        oninput: function (ev) { S.inverter_inr = Number(ev.target.value || 0); recalc(); }
      });
      left.appendChild(inputRow('Inverter ₹', invInput));

      // battery
      const batSel = h('select', { style: inputStyle(),
        onchange: function (ev) { S.battery_inr = Number(ev.target.value); recalc(); }
      });
      [['0', 'None (grid-tied)'], ['85000', '5 kWh (≈ ₹85k)'],
       ['160000', '10 kWh (≈ ₹1.6L)']].forEach(function (c) {
        batSel.appendChild(h('option', { value: c[0] }, c[1]));
      });
      left.appendChild(inputRow('Battery', batSel));

      // state
      const stateSel = h('select', { style: inputStyle(),
        onchange: function (ev) { S.state = ev.target.value; recalc(); }
      });
      [['BR', 'Bihar'], ['UP', 'UP (+₹15k)'], ['MH', 'Maharashtra (+₹10k)'],
       ['GJ', 'Gujarat (+₹20k)'], ['HR', 'Haryana (+₹17k)'],
       ['DL', 'Delhi (+₹10k)'], ['KA', 'Karnataka'], ['TS', 'Telangana'],
       ['TN', 'Tamil Nadu'], ['WB', 'WB']].forEach(function (c) {
        stateSel.appendChild(h('option', { value: c[0] }, c[1]));
      });
      left.appendChild(inputRow('State', stateSel));

      // shadow
      const shadowInput = h('input', { type: 'number',
        value: String(S.shadow_pct), style: inputStyle(),
        oninput: function (ev) { S.shadow_pct = Number(ev.target.value || 0); recalc(); }
      });
      left.appendChild(inputRow('Shadow %', shadowInput));

      // tariff
      const tariffInput = h('input', { type: 'number', step: '0.1',
        value: String(S.tariff), style: inputStyle(),
        oninput: function (ev) { S.tariff = Number(ev.target.value || 0); recalc(); }
      });
      left.appendChild(inputRow('Tariff ₹/kWh', tariffInput));

      // ─── Right column: live output ────────────────────────────────
      const right = h('div', { style: { background: '#1c1917',
        color: '#fff', borderRadius: '10px', padding: '16px',
        position: 'relative', overflow: 'hidden' } });
      right.appendChild(h('h3', { style: { margin: '0 0 12px',
        color: SOLAR_AMBER } }, '💡 Live Output'));

      function outRow(lbl, id, big) {
        const v = h('b', { id: id, style: big
          ? { color: SOLAR_AMBER, fontSize: '18px' } : {} }, '—');
        return h('div', { style: { display: 'flex',
          justifyContent: 'space-between', padding: '7px 0',
          borderBottom: big ? '0' : '1px solid #44403c',
          fontSize: big ? '15px' : '13px' } },
          h('span', {}, lbl), v);
      }
      right.appendChild(outRow('Gross system cost', 'sc_gross'));
      right.appendChild(outRow('Central subsidy', 'sc_central'));
      right.appendChild(outRow('State subsidy', 'sc_state'));
      right.appendChild(outRow('NET PRICE', 'sc_net', true));
      right.appendChild(outRow('GST', 'sc_gst'));
      right.appendChild(outRow('Monthly EMI', 'sc_emi'));
      right.appendChild(h('hr', { style: { borderColor: '#44403c', margin: '12px 0' } }));
      right.appendChild(outRow('Annual generation', 'sc_gen'));
      right.appendChild(outRow('Annual savings', 'sc_sav'));
      right.appendChild(outRow('PAYBACK', 'sc_pay', true));
      right.appendChild(outRow('25-yr ROI', 'sc_roi'));

      grid.appendChild(left);
      grid.appendChild(right);
      view.appendChild(grid);

      // Live recalc via backend pure-math API
      async function recalc() {
        try {
          const r = await api('api_solar_pricing_calc', S);
          const c = r.calc || {};
          const set = function (id, v) { const el = document.getElementById(id);
            if (el) el.textContent = v; };
          set('sc_gross',   fmtINRfull(c.gross_inr));
          set('sc_central', '−' + fmtINRfull(c.central_subsidy));
          set('sc_state',   '−' + fmtINRfull(c.state_subsidy));
          set('sc_net',     fmtINRfull(c.net_inr));
          set('sc_gst',     fmtINRfull(c.gst_inr));
          set('sc_emi',     fmtINRfull(c.emi_monthly_inr) + '/mo');
          set('sc_gen',     num(c.annual_gen_kwh) + ' kWh');
          set('sc_sav',     fmtINRfull(c.annual_savings_inr) + '/yr');
          set('sc_pay',     (c.payback_years || 0) + ' yrs');
          set('sc_roi',     fmtINRfull(c.roi_25y_inr));
        } catch (e) { console.warn('calc failed:', e); }
      }
      recalc();

      async function saveAsQuote() {
        const leadId = prompt('Lead ID for this quote? (leave blank to create quote without a lead)');
        const payload = Object.assign({}, S, {
          lead_id: leadId ? Number(leadId) : null,
          inverter_brand: tierSel.value
        });
        try {
          const r = await api('api_solar_quote_create', payload);
          if (r && r.ok) {
            toast('Quote ' + (r.quote.quote_no || '') + ' created ✓');
            try { window.location.hash = '#/solarquotes'; } catch (_) {}
          }
        } catch (e) { toast('Save failed: ' + e.message); }
      }

      function inputStyle() {
        return { width: '100%', padding: '7px 9px',
          border: '1px solid #fde68a', borderRadius: '7px',
          fontSize: '13px', background: '#fff' };
      }
    };

    // ════════════════════════════════════════════════════════════════
    //  QUOTES & PROPOSALS
    // ════════════════════════════════════════════════════════════════
    VIEWS.solarquotes = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / Quotes & Proposals', '📄 Quotes & Proposals', [
        btn('+ New from Calculator', function () {
          try { window.location.hash = '#/solarcalc'; } catch (_) {}
        }, 'primary')
      ]));

      const toolbar = h('div', { style: { display: 'flex', gap: '8px',
        alignItems: 'center', marginBottom: '12px' } });
      const statusSel = h('select', { style: { padding: '7px 10px',
        border: '1px solid #fde68a', borderRadius: '7px', fontSize: '13px' },
        onchange: function () { refresh(); }
      });
      [['', 'All statuses'], ['draft', 'Draft'], ['sent', 'Sent'],
       ['accepted', 'Accepted'], ['booked', 'Booked'],
       ['expired', 'Expired'], ['lost', 'Lost']].forEach(function (c) {
        statusSel.appendChild(h('option', { value: c[0] }, c[1]));
      });
      toolbar.appendChild(statusSel);
      toolbar.appendChild(btn('🔄 Refresh', function () { refresh(); }));
      view.appendChild(toolbar);

      const tblWrap = h('div', { style: { background: '#fff',
        border: '1px solid #fde68a', borderRadius: '10px',
        overflow: 'hidden' } });
      view.appendChild(tblWrap);

      async function refresh() {
        tblWrap.innerHTML = '<div style="padding:1rem;color:#78716c">Loading…</div>';
        let data;
        try {
          const args = {};
          if (statusSel.value) args.status = statusSel.value;
          data = await api('api_solar_quote_list', args);
        } catch (e) {
          tblWrap.innerHTML = '';
          tblWrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } },
            e.message));
          return;
        }
        tblWrap.innerHTML = '';
        if (!data.quotes || !data.quotes.length) {
          tblWrap.appendChild(h('div', { style: { padding: '24px',
            textAlign: 'center', color: '#78716c' } },
            'No quotes yet — generate one from the Pricing Calculator.'));
          return;
        }
        const tbl = h('table', { style: { width: '100%',
          borderCollapse: 'collapse', fontSize: '13px' } });
        tbl.appendChild(h('thead', {}, h('tr', {
          style: { background: '#fffbeb', fontSize: '11.5px',
            textTransform: 'uppercase', letterSpacing: '.4px', color: '#78716c' }
        }, ['Quote #', 'Lead', 'kW', 'Gross', 'Net', 'Final', 'Payback', 'Status', '']
          .map(function (l) {
            return h('th', { style: { textAlign: 'left',
              padding: '10px 12px', borderBottom: '1px solid #fde68a' } }, l);
          })
        )));
        const tbody = h('tbody', {});
        (data.quotes || []).forEach(function (q) {
          const tr = h('tr', { style: { cursor: 'pointer' },
            onclick: function () { openQuoteDetail(q, refresh); } },
            h('td', { style: tdStyle() },
              h('b', {}, q.quote_no || ('#' + q.id))),
            h('td', { style: tdStyle() }, q.lead_name || '—'),
            h('td', { style: tdStyle() }, Number(q.kw).toFixed(1)),
            h('td', { style: tdStyle() }, fmtINR(q.gross_inr)),
            h('td', { style: tdStyle() }, fmtINR(q.net_inr)),
            h('td', { style: tdStyle() }, h('b', {}, fmtINR(q.final_inr))),
            h('td', { style: tdStyle() }, (q.payback_years || 0) + ' y'),
            h('td', { style: tdStyle() }, statusPill(q.status)),
            h('td', { style: tdStyle() }, pill('View / BOM', 'info'))
          );
          tr.onmouseenter = function () { tr.style.background = '#fffbeb'; };
          tr.onmouseleave = function () { tr.style.background = '#fff'; };
          tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        tblWrap.appendChild(tbl);
      }

      function tdStyle() {
        return { padding: '10px 12px', borderBottom: '1px solid #fef3c7' };
      }
      function statusPill(s) {
        const map = { draft: 'gray', sent: 'info', accepted: 'amber',
          booked: 'ok', expired: 'warn', lost: 'bad' };
        return pill(s || 'draft', map[s] || 'gray');
      }

      refresh();
    };

    async function openQuoteDetail(quote, onDone) {
      const m = h('div', { class: 'modal-backdrop',
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
        onclick: function (ev) { if (ev.target === m) m.remove(); }
      });
      const card = h('div', { style: { background: '#fff', borderRadius: '12px',
        width: '720px', maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
        padding: '20px 24px', boxShadow: '0 20px 60px rgba(0,0,0,.3)' } });

      card.appendChild(h('h3', { style: { margin: '0 0 4px' } },
        '📄 ' + (quote.quote_no || ('Quote #' + quote.id))));
      card.appendChild(h('div', { style: { fontSize: '13px', color: '#78716c', marginBottom: '14px' } },
        (quote.lead_name || '—') + ' · ' + Number(quote.kw).toFixed(1) + ' kW · ' + (quote.state || '')));

      // Summary tiles
      card.appendChild(h('div', { style: { display: 'flex', gap: '10px', marginBottom: '14px' } },
        kpiTile('Gross', fmtINR(quote.gross_inr), ''),
        kpiTile('Subsidy', fmtINR(Number(quote.central_subsidy || 0) + Number(quote.state_subsidy || 0)), 'central + state', '#10b981'),
        kpiTile('Final', fmtINR(quote.final_inr), 'incl GST'),
        kpiTile('Payback', (quote.payback_years || 0) + ' yrs', '25-yr ROI ' + fmtINR(quote.roi_25y_inr))
      ));

      // BOM
      card.appendChild(h('h4', { style: { margin: '14px 0 6px' } }, '📋 Bill of Materials'));
      const bomWrap = h('div', { style: { background: '#fffbeb',
        border: '1px solid #fde68a', borderRadius: '8px', overflow: 'hidden' } });
      card.appendChild(bomWrap);

      try {
        const r = await api('api_solar_quote_items', { quote_id: quote.id });
        const items = r.items || [];
        if (!items.length) {
          bomWrap.appendChild(h('div', { style: { padding: '14px', textAlign: 'center', color: '#78716c' } },
            'No BOM items.'));
        } else {
          const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' } });
          tbl.appendChild(h('thead', {}, h('tr', {
            style: { background: '#fef3c7' }
          }, ['Item', 'Make', 'Qty', 'Unit', 'Rate', 'Total']
            .map(function (l) {
              return h('th', { style: { textAlign: 'left',
                padding: '8px 10px', fontSize: '11px', textTransform: 'uppercase',
                letterSpacing: '.3px', color: '#92400e' } }, l);
            })
          )));
          const tbody = h('tbody', {});
          items.forEach(function (it) {
            tbody.appendChild(h('tr', {},
              h('td', { style: bomTd() }, it.item_type),
              h('td', { style: bomTd() }, it.make || '—'),
              h('td', { style: bomTd() }, num(it.qty)),
              h('td', { style: bomTd() }, it.unit || ''),
              h('td', { style: bomTd() }, fmtINRfull(it.rate)),
              h('td', { style: Object.assign({}, bomTd(), { fontWeight: 600 }) }, fmtINRfull(it.total))
            ));
          });
          tbl.appendChild(tbody);
          bomWrap.appendChild(tbl);
        }
      } catch (e) {
        bomWrap.appendChild(h('div', { style: { padding: '14px', color: '#dc2626' } }, e.message));
      }

      // Actions
      const actions = h('div', { style: { display: 'flex',
        gap: '8px', marginTop: '16px', justifyContent: 'space-between',
        flexWrap: 'wrap' } });
      const left = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
      left.appendChild(btn('Mark Sent', async function () {
        try { await api('api_solar_quote_setStatus', { quote_id: quote.id, status: 'sent' });
          toast('Marked Sent'); m.remove(); if (onDone) onDone();
        } catch (e) { toast(e.message); }
      }));
      left.appendChild(btn('Mark Booked', async function () {
        try {
          await api('api_solar_quote_setStatus', { quote_id: quote.id, status: 'booked' });
          // Create installation project automatically
          await api('api_solar_install_create', {
            lead_id: quote.lead_id, quote_id: quote.id,
            kw: quote.kw, total_inr: quote.final_inr
          });
          toast('Booked + Install project created ✓');
          m.remove(); if (onDone) onDone();
        } catch (e) { toast(e.message); }
      }, 'primary'));
      left.appendChild(btn('Mark Lost', async function () {
        try { await api('api_solar_quote_setStatus', { quote_id: quote.id, status: 'lost' });
          toast('Marked Lost'); m.remove(); if (onDone) onDone();
        } catch (e) { toast(e.message); }
      }));
      actions.appendChild(left);
      actions.appendChild(btn('Close', function () { m.remove(); }));
      card.appendChild(actions);

      m.appendChild(card);
      document.body.appendChild(m);

      function bomTd() {
        return { padding: '8px 10px', borderBottom: '1px solid #fef3c7' };
      }
    }

    // ════════════════════════════════════════════════════════════════
    //  INSTALLATION TRACKER — List + Kanban + Timeline
    // ════════════════════════════════════════════════════════════════
    const STAGE_INFO = [
      { seq: 1, code: 'quoted',       label: 'Quoted',        color: '#f5f5f4', fg: '#57534e' },
      { seq: 2, code: 'booked',       label: 'Booked',        color: '#fef3c7', fg: '#92400e' },
      { seq: 3, code: 'design',       label: 'Design ✓',      color: '#fef9c3', fg: '#854d0e' },
      { seq: 4, code: 'discom',       label: 'DISCOM ✓',      color: '#dbeafe', fg: '#1e40af' },
      { seq: 5, code: 'dispatch',     label: 'Dispatched',    color: '#fed7aa', fg: '#9a3412' },
      { seq: 6, code: 'installing',   label: 'Installing',    color: '#fde68a', fg: '#92400e' },
      { seq: 7, code: 'netmeter',     label: 'Net-meter',     color: '#bfdbfe', fg: '#1e40af' },
      { seq: 8, code: 'pto',          label: 'PTO',           color: '#bbf7d0', fg: '#166534' },
      { seq: 9, code: 'commissioned', label: '✓ LIVE',        color: '#86efac', fg: '#14532d' }
    ];

    VIEWS.solarinstalls = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / Installation Tracker', '🔧 Installation Tracker', [
        btn('🔄 Refresh', function () { refresh(); })
      ]));

      // View toggle (List / Kanban / Timeline)
      let mode = 'list';
      try { mode = localStorage.getItem('solar_install_view') || 'list'; } catch (_) {}
      const toggleWrap = h('div', { style: { display: 'flex', background: '#fef3c7',
        padding: '3px', borderRadius: '8px', width: 'fit-content',
        marginBottom: '14px' } });
      ['list', 'kanban', 'timeline'].forEach(function (m) {
        const label = m === 'list' ? '📋 List' : m === 'kanban' ? '🗂 Kanban' : '📅 Timeline';
        const b = h('button', {
          style: viewBtnStyle(mode === m),
          onclick: function () {
            mode = m;
            try { localStorage.setItem('solar_install_view', m); } catch (_) {}
            Array.from(toggleWrap.children).forEach(function (x, i) {
              const isOn = ['list', 'kanban', 'timeline'][i] === m;
              Object.assign(x.style, viewBtnStyle(isOn));
            });
            render();
          }
        }, label);
        toggleWrap.appendChild(b);
      });
      view.appendChild(toggleWrap);
      function viewBtnStyle(on) {
        return {
          padding: '6px 12px', border: 0,
          background: on ? '#fff' : 'transparent',
          color: on ? SOLAR_AMBER2 : '#78716c',
          borderRadius: '6px', fontSize: '12.5px', fontWeight: 600,
          cursor: 'pointer', boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none'
        };
      }

      // Filter row
      const filterRow = h('div', { style: { display: 'flex', gap: '8px',
        alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } });
      const stageSel = h('select', { style: { padding: '7px 10px',
        border: '1px solid #fde68a', borderRadius: '7px', fontSize: '13px' },
        onchange: render
      });
      stageSel.appendChild(h('option', { value: '' }, 'All stages'));
      STAGE_INFO.forEach(function (s) {
        stageSel.appendChild(h('option', { value: String(s.seq) }, s.seq + '. ' + s.label));
      });
      filterRow.appendChild(stageSel);
      view.appendChild(filterRow);

      const body = h('div', {});
      view.appendChild(body);

      // KPI strip from summary
      let summary = {};
      try { summary = await api('api_solar_install_summary'); } catch (_) {}
      const k = summary.kpis || {};
      const kpiStrip = h('div', { style: { display: 'flex', gap: '12px',
        flexWrap: 'wrap', marginBottom: '14px' } },
        kpiTile('Active projects', String(k.active || 0),
          Number(k.active_kw || 0).toFixed(1) + ' kW total'),
        kpiTile('Avg cycle', (k.avg_cycle_days || 0).toFixed
          ? (k.avg_cycle_days).toFixed(0) + 'd' : (k.avg_cycle_days || '—'), 'booked → live'),
        kpiTile('Commissioned (mo)', String(k.commissioned_month || 0), 'this month', '#10b981')
      );
      view.insertBefore(kpiStrip, filterRow);

      let installs = [];
      async function refresh() {
        body.innerHTML = '<div style="padding:1rem;color:#78716c">Loading…</div>';
        try {
          const args = {};
          if (stageSel.value) args.stage = Number(stageSel.value);
          const r = await api('api_solar_install_list', args);
          installs = r.installs || [];
        } catch (e) {
          body.innerHTML = '';
          body.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        render();
      }

      function render() {
        body.innerHTML = '';
        if (!installs.length) {
          body.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            color: '#78716c', background: '#fff', border: '1px solid #fde68a',
            borderRadius: '10px' } },
            'No active installations. Quotes marked "Booked" become installation projects automatically.'));
          return;
        }
        if (mode === 'list')     renderList(body, installs);
        else if (mode === 'kanban')   renderKanban(body, installs);
        else                      renderTimeline(body, installs);
      }

      refresh();
    };

    function renderList(body, installs) {
      const wrap = h('div', { style: { background: '#fff',
        border: '1px solid #fde68a', borderRadius: '10px', overflow: 'hidden' } });
      const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse',
        fontSize: '13px' } });
      tbl.appendChild(h('thead', {}, h('tr', {
        style: { background: '#fffbeb', fontSize: '11.5px', textTransform: 'uppercase',
          letterSpacing: '.4px', color: '#78716c' }
      },
        ['Project', 'Customer', 'kW', 'Value', 'Current Stage', 'Progress', 'Owner', '']
          .map(function (l) {
            return h('th', { style: { textAlign: 'left',
              padding: '10px 12px', borderBottom: '1px solid #fde68a' } }, l);
          })
      )));
      const tbody = h('tbody', {});
      installs.forEach(function (i) {
        const stage = STAGE_INFO[Math.min(8, Math.max(0, Number(i.current_stage || 1) - 1))];
        const tr = h('tr', { style: { cursor: 'pointer' },
          onclick: function () { openInstallDetail(i); } },
          h('td', { style: tdStyle() }, h('b', {}, i.project_no || ('#' + i.id))),
          h('td', { style: tdStyle() },
            h('div', {}, i.lead_name || '—'),
            h('div', { style: { fontSize: '11px', color: '#78716c' } },
              (i.lead_city || '') + (i.lead_phone ? ' · ' + i.lead_phone : ''))),
          h('td', { style: tdStyle() }, Number(i.kw || 0).toFixed(1) + ' kW'),
          h('td', { style: tdStyle() }, fmtINR(i.total_inr || 0)),
          h('td', { style: tdStyle() },
            h('span', { style: { background: stage.color, color: stage.fg,
              padding: '3px 9px', borderRadius: '99px', fontSize: '11px',
              fontWeight: 700 } }, stage.seq + '. ' + stage.label)),
          h('td', { style: tdStyle() }, progressDots(Number(i.current_stage || 1))),
          h('td', { style: tdStyle() }, i.owner_name || '—'),
          h('td', { style: tdStyle() }, pill('View', 'info'))
        );
        tr.onmouseenter = function () { tr.style.background = '#fffbeb'; };
        tr.onmouseleave = function () { tr.style.background = '#fff'; };
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      body.appendChild(wrap);

      function tdStyle() {
        return { padding: '10px 12px', borderBottom: '1px solid #fef3c7' };
      }
      function progressDots(currentSeq) {
        const wrap = h('div', { style: { display: 'flex', alignItems: 'center',
          gap: '6px' } });
        const dots = h('div', { style: { display: 'flex', gap: '3px' } });
        for (let s = 1; s <= 9; s++) {
          const c = s < currentSeq ? '#10b981' : (s === currentSeq ? '#f59e0b' : '#fef3c7');
          dots.appendChild(h('div', { style: { width: '10px', height: '10px',
            borderRadius: '50%', background: c, boxShadow: s === currentSeq
              ? '0 0 0 2px #fef3c7' : 'none' } }));
        }
        wrap.appendChild(dots);
        wrap.appendChild(h('span', { style: { fontSize: '11px', color: '#78716c' } },
          currentSeq + '/9'));
        return wrap;
      }
    }

    function renderKanban(body, installs) {
      // First 5 columns then second row of 4 — matches mockup
      const wrap = h('div', { style: { display: 'grid',
        gridTemplateColumns: 'repeat(5,1fr)', gap: '8px', marginBottom: '8px' } });
      const wrap2 = h('div', { style: { display: 'grid',
        gridTemplateColumns: 'repeat(4,1fr)', gap: '8px' } });

      function col(stage) {
        const inThis = installs.filter(function (i) {
          return Number(i.current_stage || 1) === stage.seq;
        });
        const c = h('div', { style: { background: '#fffbeb',
          border: '1px solid #fde68a', borderRadius: '10px', padding: '8px',
          minHeight: '180px' } });
        c.appendChild(h('h3', { style: { fontSize: '11.5px', margin: '0 0 8px',
          textTransform: 'uppercase', letterSpacing: '.4px', color: '#78716c',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('span', {}, stage.seq + '. ' + stage.label),
          h('span', { style: { background: '#fbbf24', color: '#1c1917',
            padding: '1px 7px', borderRadius: '99px', fontSize: '10px',
            fontWeight: 700 } }, String(inThis.length))
        ));
        inThis.forEach(function (i) {
          c.appendChild(h('div', { style: { background: '#fff',
            border: '1px solid #fde68a', borderRadius: '8px', padding: '9px',
            marginBottom: '6px', cursor: 'pointer' },
            onclick: function () { openInstallDetail(i); }
          },
            h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, i.lead_name || '—'),
            h('div', { style: { fontSize: '11px', color: '#78716c', margin: '3px 0' } },
              Number(i.kw || 0).toFixed(1) + ' kW · ' + fmtINR(i.total_inr || 0)),
            h('div', { style: { fontSize: '11px', color: '#78716c' } }, i.lead_city || '')
          ));
        });
        return c;
      }
      [1, 2, 3, 4, 5].forEach(function (s) { wrap.appendChild(col(STAGE_INFO[s - 1])); });
      [6, 7, 8, 9].forEach(function (s) { wrap2.appendChild(col(STAGE_INFO[s - 1])); });
      body.appendChild(wrap);
      body.appendChild(wrap2);
    }

    function renderTimeline(body, installs) {
      const wrap = h('div', { style: { background: '#fff',
        border: '1px solid #fde68a', borderRadius: '10px',
        padding: '14px', overflow: 'auto' } });
      wrap.appendChild(h('h3', { style: { margin: '0 0 8px', fontSize: '13px' } },
        '📅 Each row = a project · column shading shows current stage'));

      const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse',
        fontSize: '12px' } });
      const headRow = h('tr', { style: { background: '#fffbeb' } },
        h('th', { style: { textAlign: 'left', padding: '8px',
          borderBottom: '1px solid #fde68a', minWidth: '180px' } }, 'Project'));
      STAGE_INFO.forEach(function (s) {
        headRow.appendChild(h('th', { style: { textAlign: 'center',
          padding: '8px 4px', borderBottom: '1px solid #fde68a',
          fontSize: '10.5px' } }, s.seq + ''));
      });
      tbl.appendChild(h('thead', {}, headRow));

      const tbody = h('tbody', {});
      installs.forEach(function (i) {
        const tr = h('tr', { style: { cursor: 'pointer' },
          onclick: function () { openInstallDetail(i); } });
        tr.appendChild(h('td', { style: { padding: '8px',
          borderBottom: '1px solid #fef3c7' } },
          h('b', {}, i.lead_name || '—'),
          h('div', { style: { fontSize: '11px', color: '#78716c' } },
            Number(i.kw || 0).toFixed(1) + ' kW · ' + (i.project_no || ''))));
        STAGE_INFO.forEach(function (s) {
          const cur = Number(i.current_stage || 1);
          const cell = h('td', { style: { textAlign: 'center',
            padding: '8px 4px', borderBottom: '1px solid #fef3c7' } });
          if (s.seq < cur) {
            cell.style.background = '#86efac';
            cell.style.color = '#14532d';
            cell.appendChild(h('span', { style: { fontSize: '14px' } }, '✓'));
          } else if (s.seq === cur) {
            cell.style.background = s.color;
            cell.style.color = s.fg;
            cell.style.fontWeight = '700';
            cell.appendChild(h('span', {}, '●'));
          }
          tr.appendChild(cell);
        });
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      body.appendChild(wrap);
    }

    async function openInstallDetail(install) {
      const m = h('div', { class: 'modal-backdrop',
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
        onclick: function (ev) { if (ev.target === m) m.remove(); }
      });
      const card = h('div', { style: { background: '#fff', borderRadius: '12px',
        width: '720px', maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
        padding: '20px 24px', boxShadow: '0 20px 60px rgba(0,0,0,.3)' } });

      card.appendChild(h('h3', { style: { margin: '0 0 4px' } },
        '🔧 ' + (install.project_no || ('#' + install.id))));
      card.appendChild(h('div', { style: { fontSize: '13px', color: '#78716c', marginBottom: '14px' } },
        (install.lead_name || '—') + ' · ' + Number(install.kw || 0).toFixed(1) + ' kW · ' + fmtINR(install.total_inr || 0)));

      // Milestones list
      const wrap = h('div', { style: { background: '#fffbeb',
        border: '1px solid #fde68a', borderRadius: '8px', padding: '8px' } });
      try {
        const r = await api('api_solar_install_milestones', { install_id: install.id });
        const ms = r.milestones || [];
        ms.forEach(function (mile) {
          const stage = STAGE_INFO[mile.seq - 1] || {};
          const isDone = mile.status === 'done';
          const isCur  = mile.status === 'in_progress';
          const row = h('div', { style: { display: 'flex', alignItems: 'center',
            gap: '10px', padding: '8px', background: isCur ? '#fff' : 'transparent',
            borderRadius: '6px', marginBottom: '3px' } },
            h('div', { style: { width: '28px', height: '28px', borderRadius: '50%',
              background: isDone ? '#10b981' : (isCur ? '#f59e0b' : '#fef3c7'),
              color: isDone || isCur ? '#fff' : '#78716c',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: '13px' } }, isDone ? '✓' : String(mile.seq)),
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: 600, fontSize: '13px' } }, mile.label),
              h('div', { style: { fontSize: '11px', color: '#78716c' } },
                isDone && mile.actual_date ? 'Done ' + (mile.actual_date || '') : (isCur ? '⏳ In progress' : 'Pending'))
            ),
            h('div', {}, statusBadge(mile.status))
          );
          wrap.appendChild(row);
        });
      } catch (e) {
        wrap.appendChild(h('div', { style: { color: '#dc2626', padding: '8px' } }, e.message));
      }
      card.appendChild(wrap);

      // Actions
      const actions = h('div', { style: { display: 'flex', gap: '8px',
        marginTop: '16px', justifyContent: 'space-between' } });
      actions.appendChild(btn('Close', function () { m.remove(); }));
      if (Number(install.current_stage || 1) < 9) {
        actions.appendChild(btn('⬆ Advance to next stage', async function () {
          try {
            const r = await api('api_solar_install_advance', { install_id: install.id });
            if (r && r.ok) {
              toast(r.commissioned ? '🌞 Plant LIVE — Commissioned!' : 'Advanced to stage ' + r.advanced_to);
              m.remove();
              try { window.location.hash = '#/solarinstalls'; setTimeout(function () { window.location.reload(); }, 300); } catch (_) {}
            }
          } catch (e) { toast(e.message); }
        }, 'primary'));
      }
      card.appendChild(actions);

      m.appendChild(card);
      document.body.appendChild(m);

      function statusBadge(s) {
        if (s === 'done') return pill('Done ✓', 'ok');
        if (s === 'in_progress') return pill('In progress', 'amber');
        if (s === 'blocked') return pill('Blocked', 'bad');
        return pill('Pending', 'gray');
      }
    }

    // ════════════════════════════════════════════════════════════════
    //  PLACEHOLDERS — Commit 3
    // ════════════════════════════════════════════════════════════════

    VIEWS.solarsubsidies = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / Subsidy Tracker', '🏛️ Subsidy Tracker — PM-Surya Ghar', [
        btn('🔄 Refresh', function () { refresh(); })
      ]));

      let rep = {};
      try { rep = await api('api_solar_subsidy_report'); } catch (_) {}
      const k = rep.kpis || {};
      view.appendChild(h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' } },
        kpiTile('In pipeline',    String(k.in_pipeline || 0), 'active applications'),
        kpiTile('Disbursed (FY)', fmtINR(k.disbursed_fy || 0), 'this financial year', '#10b981'),
        kpiTile('Stuck > 30d',    String(k.stuck || 0), 'escalate today', '#dc2626'),
        kpiTile('Pending amount', fmtINR(k.pending_amt || 0), 'to be disbursed')
      ));

      // Filter row
      const filterRow = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } });
      let filter = 'all';
      ['all', 'stuck', 'disbursed'].forEach(function (f) {
        const b = h('button', {
          style: pillBtnStyle(filter === f),
          onclick: function () { filter = f; refresh(); render(); }
        }, f === 'all' ? 'All' : f === 'stuck' ? 'Stuck > 30d' : 'Disbursed');
        filterRow.appendChild(b);
      });
      function pillBtnStyle(on) {
        return {
          padding: '6px 12px', border: '1px solid #fde68a',
          background: on ? '#fbbf24' : '#fff', color: '#1c1917',
          borderRadius: '7px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer'
        };
      }
      view.appendChild(filterRow);

      const tblWrap = h('div', { style: { background: '#fff', border: '1px solid #fde68a',
        borderRadius: '10px', overflow: 'hidden' } });
      view.appendChild(tblWrap);

      function render() {
        Array.from(filterRow.children).forEach(function (b, i) {
          const f = ['all', 'stuck', 'disbursed'][i];
          Object.assign(b.style, pillBtnStyle(filter === f));
        });
      }

      async function refresh() {
        tblWrap.innerHTML = '<div style="padding:1rem;color:#78716c">Loading…</div>';
        let data;
        try {
          const args = {};
          if (filter === 'stuck') args.stuck = true;
          if (filter === 'disbursed') args.disbursed = true;
          data = await api('api_solar_subsidy_list', args);
        } catch (e) {
          tblWrap.innerHTML = '';
          tblWrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        tblWrap.innerHTML = '';
        if (!data.subsidies || !data.subsidies.length) {
          tblWrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#78716c' } },
            'No subsidies match this filter. Subsidies are auto-created when installations are booked.'));
          return;
        }
        const STAGE_LABELS = ['Reg', 'DISCOM Apply', 'Tech Feas', 'Vendor pick', 'Install', 'Inspection', 'NM+PTO', 'Disbursed'];
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } });
        tbl.appendChild(h('thead', {}, h('tr', { style: { background: '#fffbeb' } },
          ['Project', 'State', 'Stage', 'Days in stage', 'Total days', 'Subsidy ₹', 'Action']
            .map(function (l) {
              return h('th', { style: { textAlign: 'left', padding: '10px 12px',
                borderBottom: '1px solid #fde68a', fontSize: '11.5px', textTransform: 'uppercase',
                letterSpacing: '.4px', color: '#78716c', fontWeight: 600 } }, l);
            })
        )));
        const tbody = h('tbody', {});
        data.subsidies.forEach(function (s) {
          const stage = Number(s.current_stage || 1);
          const daysInStage = Math.floor(s.days_in_stage || 0);
          const stuck = stage < 8 && daysInStage > 30;
          tbody.appendChild(h('tr', {},
            h('td', { style: td() }, h('b', {}, s.lead_name || ('#' + s.lead_id))),
            h('td', { style: td() }, s.state || '—'),
            h('td', { style: td() }, stage + '/8 ' + (STAGE_LABELS[stage - 1] || '?')),
            h('td', { style: td() },
              h('span', { style: { color: stuck ? '#dc2626' : '#1c1917', fontWeight: stuck ? 700 : 400 } },
                daysInStage + 'd' + (stuck ? ' ⚠' : ''))),
            h('td', { style: td() }, Math.floor(s.total_days || 0) + 'd'),
            h('td', { style: td() }, fmtINR(Number(s.central_inr || 0) + Number(s.state_inr || 0))),
            h('td', { style: td() },
              stage < 8
                ? h('button', {
                    style: { background: 'linear-gradient(135deg,#fbbf24,#d97706)', color: '#1c1917',
                      border: 0, padding: '4px 10px', borderRadius: '6px', fontSize: '11.5px',
                      fontWeight: 700, cursor: 'pointer' },
                    onclick: async function () {
                      try { await api('api_solar_subsidy_advance', { subsidy_id: s.id });
                        toast('Advanced to stage ' + (stage + 1));
                        refresh();
                      } catch (e) { toast(e.message); }
                    }
                  }, '⬆ Advance')
                : pill('✓ Disbursed', 'ok'))
          ));
        });
        tbl.appendChild(tbody);
        tblWrap.appendChild(tbl);

        function td() { return { padding: '10px 12px', borderBottom: '1px solid #fef3c7' }; }
      }
      refresh();
    };
    VIEWS.solaramc = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / AMC', '🛠️ AMC / Service Tracker', [
        btn('🔄 Refresh', function () { refresh(); })
      ]));

      let summ = {};
      try { summ = await api('api_solar_amc_summary'); } catch (_) {}
      const k = summ.kpis || {};
      view.appendChild(h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' } },
        kpiTile('AMC active',     String(k.active || 0), 'all installations'),
        kpiTile('Due 14d',        String(k.due_14d || 0), 'schedule soon'),
        kpiTile('Overdue',        String(k.overdue || 0), 'escalate', '#dc2626'),
        kpiTile('Done (this mo)', String(k.done_month || 0), 'completed', '#10b981')
      ));

      // Filter
      const filterRow = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } });
      let filter = 'all';
      ['all', 'overdue', 'due_soon'].forEach(function (f) {
        const b = h('button', {
          style: pillStyle(filter === f),
          onclick: function () { filter = f; refresh(); }
        }, f === 'all' ? 'All' : f === 'overdue' ? '🚨 Overdue' : '⏰ Due 14d');
        filterRow.appendChild(b);
      });
      function pillStyle(on) {
        return {
          padding: '6px 12px', border: '1px solid #fde68a',
          background: on ? '#fbbf24' : '#fff', color: '#1c1917',
          borderRadius: '7px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer'
        };
      }
      view.appendChild(filterRow);

      const tblWrap = h('div', { style: { background: '#fff', border: '1px solid #fde68a',
        borderRadius: '10px', overflow: 'hidden' } });
      view.appendChild(tblWrap);

      async function refresh() {
        // Update filter button states
        Array.from(filterRow.children).forEach(function (b, i) {
          const f = ['all', 'overdue', 'due_soon'][i];
          Object.assign(b.style, pillStyle(filter === f));
        });
        tblWrap.innerHTML = '<div style="padding:1rem;color:#78716c">Loading…</div>';
        let data;
        try {
          const args = {};
          if (filter === 'overdue') args.overdue = true;
          if (filter === 'due_soon') args.due_soon = true;
          data = await api('api_solar_amc_list', args);
        } catch (e) {
          tblWrap.innerHTML = '';
          tblWrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        tblWrap.innerHTML = '';
        if (!data.visits || !data.visits.length) {
          tblWrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#78716c' } },
            'No AMC visits scheduled. AMC visits are auto-created when installations are commissioned.'));
          return;
        }
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } });
        tbl.appendChild(h('thead', {}, h('tr', { style: { background: '#fffbeb' } },
          ['Customer', 'Project', 'Plan', 'Last visit', 'Next due', 'Gen since', 'Status', 'Action']
            .map(function (l) {
              return h('th', { style: { textAlign: 'left', padding: '10px 12px',
                borderBottom: '1px solid #fde68a', fontSize: '11.5px', textTransform: 'uppercase',
                letterSpacing: '.4px', color: '#78716c', fontWeight: 600 } }, l);
            })
        )));
        const tbody = h('tbody', {});
        data.visits.forEach(function (v) {
          const days = Number(v.days_until_due);
          const isOverdue = days < 0;
          const isSoon = days >= 0 && days <= 14;
          tbody.appendChild(h('tr', {},
            h('td', { style: td() }, h('b', {}, v.lead_name || '—')),
            h('td', { style: td() }, v.project_no || '—'),
            h('td', { style: td() }, v.plan_code || 'basic'),
            h('td', { style: td() }, v.last_visit_at ? String(v.last_visit_at).slice(0, 10) : '—'),
            h('td', { style: td() },
              v.next_due_at
                ? h('span', { style: { color: isOverdue ? '#dc2626' : (isSoon ? '#b45309' : '#1c1917'),
                    fontWeight: isOverdue ? 700 : 400 } },
                    String(v.next_due_at).slice(0, 10) +
                    (isOverdue ? ' (OVERDUE ' + Math.abs(days) + 'd)' : (isSoon ? ' (in ' + days + 'd)' : '')))
                : '—'),
            h('td', { style: td() }, num(v.gen_since_kwh || 0) + ' kWh'),
            h('td', { style: td() },
              v.status === 'done' ? pill('Done ✓', 'ok')
              : isOverdue ? pill('Overdue', 'bad')
              : isSoon ? pill('Due soon', 'warn')
              : pill('Scheduled', 'gray')),
            h('td', { style: td() },
              v.status !== 'done'
                ? h('button', {
                    style: { background: 'linear-gradient(135deg,#fbbf24,#d97706)', color: '#1c1917',
                      border: 0, padding: '4px 10px', borderRadius: '6px', fontSize: '11.5px',
                      fontWeight: 700, cursor: 'pointer' },
                    onclick: async function () {
                      const notes = prompt('Visit done — any issues found?', '');
                      try { await api('api_solar_amc_markDone', { visit_id: v.id, issues: notes || null });
                        toast('Visit marked done');
                        refresh();
                      } catch (e) { toast(e.message); }
                    }
                  }, '✓ Mark Done')
                : '—')
          ));
        });
        tbl.appendChild(tbody);
        tblWrap.appendChild(tbl);

        function td() { return { padding: '10px 12px', borderBottom: '1px solid #fef3c7' }; }
      }
      refresh();
    };
    VIEWS.solarinsights = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Solar / AI Insights', '🤖 AI Insights', [
        btn('🔄 Regenerate', function () { refresh(); })
      ]));
      const wrap = h('div', {}); view.appendChild(wrap);

      async function refresh() {
        wrap.innerHTML = '<div style="padding:1rem;color:#78716c">Generating…</div>';
        let data;
        try { data = await api('api_solar_insights_get'); }
        catch (e) {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        wrap.innerHTML = '';
        const ins = data.insights || [];
        if (!ins.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#78716c',
            background: '#fff', border: '1px solid #fde68a', borderRadius: '10px' } },
            'No insights yet. Seed demo data first to populate the dashboard.'));
          return;
        }
        wrap.appendChild(h('div', { style: { color: '#78716c', fontSize: '12px', marginBottom: '12px' } },
          ins.length + ' insights · generated ' + new Date(data.generated_at).toLocaleString('en-IN') +
          ' · weekly Gemini-powered digest ships in v1.2'));

        const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } });
        const borderMap = { growth: '#10b981', warning: '#dc2626', suggest: '#a855f7', trend: '#0ea5e9' };
        ins.forEach(function (ins) {
          const card = h('div', { style: {
            background: '#fff', border: '1px solid #fde68a', borderRadius: '10px',
            padding: '14px', borderLeft: '4px solid ' + (borderMap[ins.type] || '#fbbf24')
          } },
            h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px' } },
              h('div', { style: { fontSize: '22px' } }, ins.emoji),
              h('div', { style: { flex: 1 } },
                h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, ins.headline),
                h('div', { style: { fontSize: '12.5px', color: '#57534e' } }, ins.detail),
                h('div', { style: { marginTop: '8px', fontSize: '12px', fontWeight: 600,
                  borderTop: '1px solid #fde68a', paddingTop: '6px', color: '#d97706' } },
                  '→ ' + ins.action)
              )
            )
          );
          grid.appendChild(card);
        });
        wrap.appendChild(grid);
      }
      refresh();
    };

    console.log('[SOLAR_PACK_v1] views wired:',
      'packsolar, solarsites, solarcalc, solarquotes, solarinstalls (+ subsidies/amc/insights stubs)');
  });
})();
