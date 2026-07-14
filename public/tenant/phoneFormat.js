/* PHONE_FORMAT_v1 — Admin SPA view for per-source phone normalization.
 * Available at #/phoneformat (admin only).                              */
(function () {
  'use strict';
  function _ready(fn) {
    if (window.api && window.h && window.VIEWS) return fn();
    setTimeout(function () { _ready(fn); }, 60);
  }

  const COUNTRIES = [
    ['IN','India (+91)'], ['US','USA (+1)'], ['UK','UK (+44)'], ['AE','UAE (+971)'],
    ['SG','Singapore (+65)'], ['AU','Australia (+61)'], ['CA','Canada (+1)'],
    ['DE','Germany (+49)'], ['FR','France (+33)'], ['SA','Saudi (+966)'],
    ['BD','Bangladesh (+880)'], ['PK','Pakistan (+92)'], ['NP','Nepal (+977)'],
    ['LK','Sri Lanka (+94)'], ['MY','Malaysia (+60)'], ['TH','Thailand (+66)'],
    ['ID','Indonesia (+62)'], ['PH','Philippines (+63)']
  ];

  const SRC_FORMATS = [
    ['auto',      'Auto-detect (recommended)'],
    ['cc_noplus', '12-digit with country code (91XXXXXXXXXX)'],
    ['local',     '10-digit local (XXXXXXXXXX)'],
    ['e164',      'E.164 with + (+91XXXXXXXXXX)'],
    ['raw',       'Other / mixed']
  ];
  const STORE_FORMATS = [
    ['raw',       'Keep raw (no changes)'],
    ['e164',      'E.164 with + prefix   → +919876543210'],
    ['cc_noplus', 'Country code, no +    → 919876543210'],
    ['local',     'Local 10-digit        → 9876543210']
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function _toast(msg, kind) { try { window.toast ? window.toast(msg, kind) : alert(msg); } catch (_) { alert(msg); } }

  async function render(view) {
    view.innerHTML = '<div style="padding:20px;color:#64748b">Loading…</div>';
    let sources = [];
    try {
      const r = await api('api_phoneFormat_listSources');
      sources = (r && r.sources) || [];
    } catch (e) {
      view.innerHTML = '<div class="card" style="margin:20px;padding:20px;color:#dc2626">Failed to load: ' + esc(e.message) + '</div>';
      return;
    }
    if (!sources.length) sources = [{ source: 'indiamart', configured: false }];

    view.innerHTML =
      '<div style="padding:20px;max-width:1100px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
        '<div><h1 style="margin:0;font-size:22px">📞 Phone Number Format (per Webhook / Source)</h1>' +
        '<div style="color:#64748b;font-size:13px;margin-top:4px">Normalize incoming phone numbers per lead source. E.g., strip 91-prefix from IndiaMart, keep +91 on Meta.</div></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:260px 1fr;gap:16px">' +
        '<div class="card" style="padding:12px" id="pf-sources">' +
          '<h3 style="margin:0 0 10px;font-size:13px;text-transform:uppercase;color:#6b7280;letter-spacing:1px">Lead Sources</h3>' +
          sources.map(function (s, i) {
            return '<div class="pf-src-row" data-src="' + esc(s.source) + '" style="padding:8px 10px;border-radius:6px;cursor:pointer;margin-bottom:2px;display:flex;justify-content:space-between;align-items:center;font-size:13px' +
              (i === 0 ? ';background:#eff6ff;color:#1e40af;font-weight:700' : '') + '">' +
              '<span>' + esc(s.source) + '</span>' +
              (s.configured ? '<span style="font-size:10px;color:#059669;font-weight:700">●</span>' : '') +
            '</div>';
          }).join('') +
        '</div>' +
        '<div id="pf-editor"></div>' +
      '</div></div>';

    let activeSource = sources[0].source;
    async function _open(src) {
      activeSource = src;
      /* highlight active row */
      Array.from(view.querySelectorAll('.pf-src-row')).forEach(function (r) {
        if (r.getAttribute('data-src') === src) { r.style.background = '#eff6ff'; r.style.color = '#1e40af'; r.style.fontWeight = '700'; }
        else { r.style.background = ''; r.style.color = ''; r.style.fontWeight = ''; }
      });
      const box = view.querySelector('#pf-editor');
      box.innerHTML = '<div class="card" style="padding:20px;color:#64748b">Loading rule…</div>';
      const r = await api('api_phoneFormat_get', src);
      const rule = r.rule || {};
      box.innerHTML =
        '<div class="card" style="padding:22px">' +
        '<h2 style="margin:0 0 4px;font-size:18px">Rule for source: <span style="color:#7c3aed">' + esc(src) + '</span></h2>' +
        '<div style="color:#64748b;font-size:12px;margin-bottom:18px">Changes apply to NEW leads from this source. Existing leads unaffected until backfill.</div>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
          _fld('Incoming format', 'pf-src-fmt', SRC_FORMATS, rule.source_format || 'auto') +
          _fld('Store in CRM as', 'pf-store-fmt', STORE_FORMATS, rule.store_format || 'raw') +
          _fld('Default country', 'pf-cc', COUNTRIES, (rule.default_cc || 'IN')) +
          '<div style="padding-top:16px">' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:6px"><input type="checkbox" id="pf-wa"' + (rule.apply_to_wa ? ' checked' : '') + '> Also apply to WhatsApp field</label>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:6px"><input type="checkbox" id="pf-rej"' + (rule.reject_invalid ? ' checked' : '') + '> Reject leads with invalid phone</label>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="pf-dedupe"' + (rule.dedupe_on_phone !== false ? ' checked' : '') + '> Deduplicate against existing leads</label>' +
          '</div>' +
        '</div>' +

        '<div style="margin-top:18px;padding:12px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px">' +
          '<div style="font-size:11px;text-transform:uppercase;font-weight:700;color:#64748b;letter-spacing:1px;margin-bottom:8px">Live preview</div>' +
          '<div id="pf-preview" style="font-family:monospace;font-size:12.5px;color:#334155">Click "Test on last 5" to see how sample payloads transform.</div>' +
        '</div>' +

        '<div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="btn ghost" id="pf-test">🧪 Test on last 5</button>' +
          '<button class="btn primary" id="pf-save">💾 Save rule</button>' +
        '</div>' +

        '<hr style="margin:22px 0;border:0;border-top:1px solid #e5e7eb">' +

        '<h3 style="margin:0 0 4px;font-size:15px">🔄 Backfill existing leads from this source</h3>' +
        '<div style="color:#64748b;font-size:12px;margin-bottom:14px">Preview first (safe, no changes). Apply only after reviewing the diff.</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">' +
          '<label style="font-size:13px">Batch size:</label>' +
          '<input id="pf-bf-limit" type="number" value="500" min="1" max="10000" style="width:120px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px">' +
          '<button class="btn ghost" id="pf-bf-preview">👁 Preview</button>' +
          '<button class="btn primary" id="pf-bf-apply" style="background:#dc2626">⚡ Apply Backfill</button>' +
        '</div>' +
        '<div id="pf-bf-result"></div>' +
        '</div>';

      box.querySelector('#pf-test').onclick   = function () { _test(src); };
      box.querySelector('#pf-save').onclick   = function () { _save(src); };
      box.querySelector('#pf-bf-preview').onclick = function () { _bf(src, 'preview'); };
      box.querySelector('#pf-bf-apply').onclick   = function () { _bf(src, 'apply'); };
    }

    function _rule() {
      return {
        source_format:  view.querySelector('#pf-src-fmt').value,
        store_format:   view.querySelector('#pf-store-fmt').value,
        default_cc:     view.querySelector('#pf-cc').value,
        apply_to_wa:    view.querySelector('#pf-wa').checked,
        reject_invalid: view.querySelector('#pf-rej').checked,
        dedupe_on_phone:view.querySelector('#pf-dedupe').checked
      };
    }

    async function _save(src) {
      try { await api('api_phoneFormat_save', src, _rule()); _toast('✓ Rule saved for ' + src); }
      catch (e) { _toast('Save failed: ' + e.message, 'err'); }
    }
    async function _test(src) {
      try {
        /* Save first (temp preview uses saved rule) */
        await api('api_phoneFormat_save', src, _rule());
        const r = await api('api_phoneFormat_test', src, null);
        const box = view.querySelector('#pf-preview');
        if (!r.rows || !r.rows.length) { box.textContent = 'No sample payloads available.'; return; }
        box.innerHTML =
          '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
            '<tr style="background:#e5e7eb"><th style="text-align:left;padding:6px">Raw</th><th style="text-align:left;padding:6px">Will save as</th><th style="text-align:left;padding:6px">Status</th></tr>' +
            r.rows.map(function (x) {
              return '<tr><td style="padding:6px;border-bottom:1px solid #f1f5f9">' + esc(x.raw) + '</td>' +
                '<td style="padding:6px;border-bottom:1px solid #f1f5f9;font-weight:700;color:#1e40af">' + esc(x.normalized) + '</td>' +
                '<td style="padding:6px;border-bottom:1px solid #f1f5f9">' +
                  (x.valid ? '<span style="color:#059669">✓ OK</span>' : '<span style="color:#dc2626">⚠ Invalid</span>') +
                  (x.changed ? '' : '<span style="color:#94a3b8;margin-left:6px">(unchanged)</span>') +
                '</td></tr>';
            }).join('') +
          '</table>';
      } catch (e) { _toast('Test failed: ' + e.message, 'err'); }
    }
    async function _bf(src, mode) {
      const limit = Number(view.querySelector('#pf-bf-limit').value) || 500;
      const box = view.querySelector('#pf-bf-result');
      box.innerHTML = '<div style="padding:10px;color:#64748b">Running ' + mode + '…</div>';
      try {
        const fn = mode === 'apply' ? 'api_phoneFormat_backfill_apply' : 'api_phoneFormat_backfill_preview';
        if (mode === 'apply' && !confirm('Apply backfill to up to ' + limit + ' existing leads from source "' + src + '"? This will UPDATE their phone column (raw kept in phone_raw).')) {
          box.innerHTML = ''; return;
        }
        const r = await api(fn, _rule(), { source: src, limit: limit });
        if (mode === 'preview') {
          box.innerHTML =
            '<div style="padding:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:13px;margin-bottom:10px">' +
              '<b>' + r.total + '</b> leads scanned · <b style="color:#1e40af">' + r.changed + '</b> will change · <b style="color:#dc2626">' + r.invalid + '</b> invalid · <b style="color:#b45309">' + (r.dupes || []).length + '</b> would collide' +
            '</div>' +
            '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
              '<tr style="background:#e5e7eb"><th style="text-align:left;padding:6px">Lead</th><th style="text-align:left;padding:6px">Before</th><th style="text-align:left;padding:6px">After</th><th style="text-align:left;padding:6px">Status</th></tr>' +
              (r.preview || []).slice(0, 50).map(function (x) {
                return '<tr>' +
                  '<td style="padding:6px;border-bottom:1px solid #f1f5f9">#' + x.id + ' ' + esc(x.name) + '</td>' +
                  '<td style="padding:6px;border-bottom:1px solid #f1f5f9;font-family:monospace">' + esc(x.before) + '</td>' +
                  '<td style="padding:6px;border-bottom:1px solid #f1f5f9;font-family:monospace;color:' + (x.changed?'#1e40af':'#94a3b8') + ';font-weight:600">' + esc(x.after) + '</td>' +
                  '<td style="padding:6px;border-bottom:1px solid #f1f5f9">' + (x.valid ? '<span style="color:#059669">✓</span>' : '<span style="color:#dc2626">⚠</span>') + (x.changed ? '' : '<span style="color:#94a3b8;font-size:10px;margin-left:6px">unchanged</span>') + '</td>' +
                '</tr>';
              }).join('') +
            '</table>' +
            ((r.preview || []).length > 50 ? '<div style="padding:8px;color:#64748b;font-size:12px">…showing first 50 of ' + (r.preview || []).length + ' rows</div>' : '');
        } else {
          box.innerHTML =
            '<div style="padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:13px;color:#166534">' +
              '<b>✓ Backfill complete.</b> ' + r.updated + ' leads updated · ' + r.unchanged + ' unchanged · ' + r.invalid + ' invalid · ' + (r.dupes || []).length + ' duplicates skipped.' +
              '<div style="margin-top:6px;font-size:11px;color:#64748b">Original phones saved to <code>phone_raw</code> column.</div>' +
            '</div>';
        }
      } catch (e) {
        box.innerHTML = '<div style="padding:10px;color:#dc2626">Failed: ' + esc(e.message) + '</div>';
      }
    }

    view.querySelectorAll('.pf-src-row').forEach(function (row) {
      row.onclick = function () { _open(row.getAttribute('data-src')); };
    });
    _open(activeSource);
  }

  function _fld(label, id, options, value) {
    return '<div><label style="display:block;font-size:11px;text-transform:uppercase;color:#6b7280;letter-spacing:1px;font-weight:700;margin-bottom:4px">' + label + '</label>' +
      '<select id="' + id + '" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">' +
      options.map(function (o) {
        return '<option value="' + o[0] + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') +
      '</select></div>';
  }

  _ready(function () {
    window.VIEWS.phoneformat = render;
  });
})();
