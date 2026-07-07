/**
 * public/tenant/waCatalogue.js — WA_CATALOGUE_v1 (2026-07-06)
 *
 * SPA module for the WhatsApp Catalogue feature. Exposes two things on window:
 *   - window.WA_CATALOGUE.render(host)  — mount the library admin view
 *   - window.WA_CATALOGUE.openPicker({phone, from_phone_number_id, onSent})
 *                                     — open the item picker (used by chat composer)
 *
 * Vserve-gated at boot; the SPA never renders itself unless the tenant has
 * WA_CATALOGUE_ENABLED='1'.
 */
(function () {
  'use strict';
  if (window.WA_CATALOGUE) return; // idempotent

  /* WA_CATALOGUE_v1 defensive access (2026-07-06) — capturing window.api /
   * window.toast at IIFE eval time can pin to `undefined` if this bundle is
   * appended before app.js finishes defining them. Use live getters. */
  const api = function () { return window.api.apply(this, arguments); };
  const toast = function (msg, kind) {
    if (typeof window.toast === 'function') return window.toast(msg, kind);
    if (typeof window.tost === 'function')  return window.tost(msg, kind);
    return alert(msg);
  };
  const h = window.h || function (tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style' && typeof attrs[k] === 'object') Object.assign(el.style, attrs[k]);
      else if (k === 'class') el.className = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    }
    kids.flat(Infinity).forEach(k => { if (k == null || k === false) return;
      el.appendChild(k.nodeType ? k : document.createTextNode(String(k))); });
    return el;
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ── Styles (scoped, one-time inject) ─────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('wacat-styles')) return;
    const s = document.createElement('style');
    s.id = 'wacat-styles';
    s.textContent = `
      .wacat-page { padding: 20px; max-width: 1200px; margin: 0 auto; }
      .wacat-head { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
      .wacat-head h2 { margin:0; font-size:22px; color:#0f172a; }
      .wacat-sub { font-size:12px; color:#64748b; margin-top:2px; }
      .wacat-btn { padding:8px 14px; border-radius:6px; border:1px solid #e5e7eb; background:#fff; font-size:13px; cursor:pointer; font-weight:500; }
      .wacat-btn.primary { background:#25d366; color:#fff; border-color:#25d366; }
      .wacat-btn.ghost { background:transparent; }
      .wacat-btn.danger { color:#b91c1c; border-color:#fecaca; }
      .wacat-btn:hover { filter:brightness(0.97); }
      .wacat-toolbar { background:#f8fafc; padding:12px 14px; border:1px solid #e5e7eb; border-bottom:0; border-radius:10px 10px 0 0; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      .wacat-search { flex:1; min-width:200px; padding:8px 12px; border:1px solid #e5e7eb; border-radius:6px; font-size:13px; }
      .wacat-select { padding:6px 10px; border:1px solid #e5e7eb; border-radius:6px; background:#fff; font-size:13px; cursor:pointer; }
      .wacat-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:14px; padding:18px; background:#fff; border:1px solid #e5e7eb; border-top:0; border-radius:0 0 10px 10px; }
      .wacat-item { border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; background:#fff; transition:box-shadow .12s, border-color .12s; cursor:pointer; position:relative; }
      .wacat-item:hover { box-shadow:0 4px 12px rgba(0,0,0,0.08); border-color:#25d366; }
      .wacat-item.picked { border-color:#25d366; box-shadow:0 0 0 2px #25d36633; }
      .wacat-item .thumb { width:100%; aspect-ratio:1/1; background:linear-gradient(135deg,#eef2ff,#e0e7ff); display:flex; align-items:center; justify-content:center; font-size:46px; color:#6366f1; overflow:hidden; }
      .wacat-item .thumb img { width:100%; height:100%; object-fit:cover; }
      .wacat-item .info { padding:8px 10px; }
      .wacat-item .name { font-size:13px; font-weight:600; color:#0f172a; margin-bottom:2px; line-height:1.3; }
      .wacat-item .meta { font-size:11px; color:#64748b; }
      .wacat-item .badge { position:absolute; top:6px; right:6px; background:rgba(0,0,0,0.7); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; font-weight:600; }
      .wacat-item .pick { position:absolute; top:6px; left:6px; width:20px; height:20px; border-radius:50%; background:#fff; border:2px solid #cbd5e1; z-index:1; }
      .wacat-item.picked .pick { background:#25d366; border-color:#25d366; box-shadow:0 0 0 2px #fff inset; }
      .wacat-empty { padding:60px 20px; text-align:center; color:#94a3b8; }
      .wacat-modal-bg { position:fixed; inset:0; background:rgba(15,23,42,0.6); z-index:9998; display:flex; align-items:center; justify-content:center; padding:16px; }
      .wacat-modal { background:#fff; border-radius:12px; max-width:560px; width:100%; max-height:90vh; overflow:auto; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
      .wacat-modal-head { padding:14px 18px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; background:#fff; z-index:1; }
      .wacat-modal-head h3 { margin:0; font-size:15px; color:#0f172a; }
      .wacat-modal-body { padding:18px; }
      .wacat-field { margin-bottom:12px; }
      .wacat-field label { font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.4px; display:block; margin-bottom:4px; font-weight:600; }
      .wacat-field input, .wacat-field select, .wacat-field textarea { width:100%; padding:8px 10px; border:1px solid #e5e7eb; border-radius:6px; font-size:13px; font-family:inherit; box-sizing:border-box; }
      .wacat-field textarea { resize:vertical; }
      .wacat-row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .wacat-drop { border:2px dashed #cbd5e1; border-radius:8px; padding:20px; text-align:center; color:#64748b; margin-bottom:14px; cursor:pointer; transition:border-color .12s; }
      .wacat-drop:hover { border-color:#25d366; color:#25d366; }
      .wacat-drop.dragover { border-color:#25d366; background:#ecfdf5; }
      .wacat-drop.hasfile { border-color:#25d366; background:#ecfdf5; color:#065f46; }
      .wacat-modal-foot { padding:12px 18px; border-top:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; gap:8px; position:sticky; bottom:0; background:#f8fafc; }

      /* Picker (chat composer) */
      .wacat-pick-wrap { position:fixed; inset:0; background:rgba(15,23,42,0.5); z-index:9997; display:flex; align-items:flex-end; justify-content:center; padding:0; }
      @media (min-width:640px) { .wacat-pick-wrap { align-items:center; padding:16px; } }
      .wacat-pick { background:#fff; border-radius:12px 12px 0 0; max-width:720px; width:100%; max-height:85vh; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 -8px 32px rgba(0,0,0,0.14); }
      @media (min-width:640px) { .wacat-pick { border-radius:12px; max-height:80vh; } }
      .wacat-pick-head { padding:12px 16px; background:#075e54; color:#fff; display:flex; justify-content:space-between; align-items:center; }
      .wacat-pick-nav { display:flex; padding:10px 14px; gap:8px; border-bottom:1px solid #f1f5f9; background:#f8fafc; overflow-x:auto; flex-shrink:0; }
      .wacat-chip { padding:6px 12px; border-radius:100px; background:#fff; border:1px solid #e5e7eb; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; }
      .wacat-chip.on { background:#25d366; color:#fff; border-color:#25d366; }
      .wacat-pick-search { padding:10px 14px; border-bottom:1px solid #f1f5f9; }
      .wacat-pick-search input { width:100%; padding:8px 12px; border:1px solid #e5e7eb; border-radius:20px; font-size:13px; box-sizing:border-box; }
      .wacat-pick-body { flex:1; overflow-y:auto; padding:0; }
      .wacat-pick-foot { padding:10px 16px; background:#f8fafc; border-top:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; }
    `;
    document.head.appendChild(s);
  }

  // ── Utilities ────────────────────────────────────────────────────────────
  const fmtPrice = (p, ccy) => p == null || p === '' ? '' : (ccy === 'USD' ? '$' : '₹') + Number(p).toLocaleString('en-IN');
  const fmtSize = (b) => {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024*1024) return (b/1024).toFixed(0) + ' KB';
    return (b/1024/1024).toFixed(1) + ' MB';
  };
  const kindOf = (mime) => {
    const m = String(mime || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    return 'document';
  };
  const emojiOf = (item) => {
    const k = kindOf(item.file_mime);
    if (k === 'image') return '🖼';
    if (k === 'video') return '🎬';
    return '📄';
  };
  function _tok() {
    try { return localStorage.getItem('token') || ''; } catch (_) { return ''; }
  }
  function _thumbSrc(item) {
    if (!item.file_url) return null;
    if (kindOf(item.file_mime) !== 'image') return null;
    let u = item.file_url;
    if (/\/api\/wa-catalogue-file\//.test(u) && !/[?&]tok=/.test(u)) {
      u += (u.indexOf('?') >= 0 ? '&' : '?') + 'tok=' + encodeURIComponent(_tok());
    }
    return u;
  }

  // ── ADMIN VIEW ───────────────────────────────────────────────────────────
  async function renderPage(host) {
    _injectStyles();
    host.innerHTML = '';
    const state = { folders: [], items: [], search: '', folderId: '', type: '', sort: 'popular' };

    const page = h('div', { class: 'wacat-page' });
    host.appendChild(page);

    async function reload() {
      try {
        const [f, i] = await Promise.all([
          api('api_wa_catalogue_folders_list').catch(() => ({ items: [] })),
          api('api_wa_catalogue_list', {
            folder_id: state.folderId || undefined,
            type: state.type || undefined,
            search: state.search || undefined,
            sort: state.sort
          }).catch(() => ({ items: [] }))
        ]);
        state.folders = f.items || [];
        state.items = i.items || [];
        renderInner();
      } catch (e) { toast('Load failed: ' + e.message, 'err'); }
    }

    function renderInner() {
      page.innerHTML = '';
      // Head
      const head = h('div', { class: 'wacat-head' },
        h('div', {},
          h('h2', {}, '📚 WhatsApp Catalogue'),
          h('div', { class: 'wacat-sub' },
            state.items.length + ' item' + (state.items.length !== 1 ? 's' : '') + ' · shared library across your team')
        ),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'wacat-btn', onclick: openFolders }, '📁 Manage folders'),
          h('button', { class: 'wacat-btn', onclick: openImport }, '📤 Bulk import CSV'),
          h('button', { class: 'wacat-btn primary', onclick: () => openEditor(null) }, '+ Add item'))
      );
      page.appendChild(head);

      // Toolbar
      const searchInp = h('input', { class: 'wacat-search', placeholder: '🔍 Search name / SKU / tag / description…', value: state.search });
      searchInp.addEventListener('input', debounce(() => { state.search = searchInp.value; reload(); }, 250));
      const folderSel = h('select', { class: 'wacat-select', onchange: e => { state.folderId = e.target.value; reload(); } },
        h('option', { value: '' }, 'All folders'),
        ...state.folders.map(f => h('option', { value: f.id, selected: String(state.folderId) === String(f.id) ? 'selected' : null }, f.name + ' (' + (f.item_count || 0) + ')')));
      const typeSel = h('select', { class: 'wacat-select', onchange: e => { state.type = e.target.value; reload(); } },
        ...['', 'image', 'video', 'document'].map(v =>
          h('option', { value: v, selected: state.type === v ? 'selected' : null }, v ? v[0].toUpperCase()+v.slice(1)+'s' : 'All types')));
      const sortSel = h('select', { class: 'wacat-select', onchange: e => { state.sort = e.target.value; reload(); } },
        h('option', { value: 'popular', selected: state.sort === 'popular' ? 'selected' : null }, 'Most sent'),
        h('option', { value: 'newest', selected: state.sort === 'newest' ? 'selected' : null }, 'Newest first'),
        h('option', { value: 'name', selected: state.sort === 'name' ? 'selected' : null }, 'Name A→Z'),
        h('option', { value: 'size', selected: state.sort === 'size' ? 'selected' : null }, 'Largest first'));
      page.appendChild(h('div', { class: 'wacat-toolbar' }, searchInp, folderSel, typeSel, sortSel));

      // Grid
      if (!state.items.length) {
        page.appendChild(h('div', { class: 'wacat-grid' },
          h('div', { class: 'wacat-empty', style: { gridColumn: '1/-1' } },
            h('div', { style: { fontSize: '48px', marginBottom: '10px' } }, '📚'),
            h('div', {}, 'No items yet — click "+ Add item" to start your library.'))));
        return;
      }
      const grid = h('div', { class: 'wacat-grid' });
      state.items.forEach(item => grid.appendChild(itemCard(item, () => openEditor(item))));
      page.appendChild(grid);
    }

    function itemCard(item, onClick) {
      const thumb = _thumbSrc(item);
      const card = h('div', { class: 'wacat-item', onclick: onClick },
        h('div', { class: 'thumb' },
          thumb ? h('img', { src: thumb, alt: item.name, onerror: function() { this.replaceWith(document.createTextNode(emojiOf(item))); } }) : emojiOf(item)),
        item.price != null && item.price !== '' ? h('div', { class: 'badge' }, fmtPrice(item.price, item.currency)) : null,
        h('div', { class: 'info' },
          h('div', { class: 'name' }, item.name),
          h('div', { class: 'meta' },
            (item.send_count > 0 ? 'Sent ' + item.send_count + '× · ' : '') +
            (item.folder_name || 'No folder') +
            (item.file_size ? ' · ' + fmtSize(item.file_size) : '')))
      );
      return card;
    }

    // ── Editor modal (add / edit) ──────────────────────────────────────────
    function openEditor(existing) {
      const modal = h('div', { class: 'wacat-modal-bg', onclick: (e) => { if (e.target === modal) modal.remove(); } });
      const st = existing
        ? Object.assign({}, existing, {
            tags: (existing.tags || []).join(', '),
            file_url: existing.file_url, file_mime: existing.file_mime, file_size: existing.file_size
          })
        : { name: '', sku: '', price: '', description: '', caption: '', tags: '', folder_id: '', file_url: '', file_mime: '', file_size: 0 };

      const dropEl = h('div', { class: 'wacat-drop' + (st.file_url ? ' hasfile' : '') },
        st.file_url
          ? h('div', {}, h('div', { style: { fontSize: '30px', marginBottom: '6px' } }, '✓'),
              h('div', { style: { fontSize: '13px' } }, 'File ready · ' + (st.file_mime || 'file') + (st.file_size ? ' · ' + fmtSize(st.file_size) : '')),
              h('div', { style: { fontSize: '11px', marginTop: '4px' } }, 'Click to replace'))
          : h('div', {}, h('div', { style: { fontSize: '36px', marginBottom: '6px' } }, '📤'),
              h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, 'Drop image / video / PDF here'),
              h('div', { style: { fontSize: '11px' } }, 'or click to pick · max 16 MB'))
      );
      const fileInp = h('input', { type: 'file', style: { display: 'none' }, accept: 'image/*,video/*,application/pdf' });
      dropEl.appendChild(fileInp);
      dropEl.addEventListener('click', () => fileInp.click());
      dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('dragover'); });
      dropEl.addEventListener('dragleave', () => dropEl.classList.remove('dragover'));
      dropEl.addEventListener('drop', e => {
        e.preventDefault(); dropEl.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) doUpload(e.dataTransfer.files[0]);
      });
      fileInp.addEventListener('change', () => { if (fileInp.files && fileInp.files[0]) doUpload(fileInp.files[0]); });

      async function doUpload(file) {
        if (file.size > 16 * 1024 * 1024) return toast('File too large (max 16 MB)', 'err');
        dropEl.innerHTML = '<div style="font-size:13px;">⏳ Uploading ' + esc(file.name) + '…</div>';
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await fetch('/api/wa-catalogue-upload', {
            method: 'POST', headers: { Authorization: 'Bearer ' + _tok() }, body: fd });
          const j = await r.json();
          if (!r.ok || j.error) throw new Error(j.error || 'upload failed');
          st.file_url = j.url;
          st.file_mime = j.mime_type;
          st.file_size = j.size;
          if (!st.name) { st.name = file.name.replace(/\.[^.]+$/, ''); nameInp.value = st.name; }
          dropEl.classList.add('hasfile');
          dropEl.innerHTML = '';
          dropEl.appendChild(h('div', {},
            h('div', { style: { fontSize: '30px', marginBottom: '6px' } }, '✓'),
            h('div', { style: { fontSize: '13px' } }, esc(file.name) + ' · ' + fmtSize(file.size)),
            h('div', { style: { fontSize: '11px', marginTop: '4px' } }, 'Click to replace')));
          dropEl.appendChild(fileInp);
        } catch (e) {
          toast('Upload failed: ' + e.message, 'err');
          dropEl.classList.remove('hasfile');
          dropEl.innerHTML = 'Upload failed — click to retry';
          dropEl.appendChild(fileInp);
        }
      }

      const nameInp = h('input', { type: 'text', value: st.name, placeholder: 'e.g. Rose bouquet — Red' });
      const skuInp  = h('input', { type: 'text', value: st.sku, placeholder: 'SKU-1204' });
      const priceInp = h('input', { type: 'number', value: st.price, step: '0.01', placeholder: '499' });
      const folderSel2 = h('select', {},
        h('option', { value: '' }, '— No folder —'),
        ...state.folders.map(f => h('option', { value: f.id, selected: String(st.folder_id) === String(f.id) ? 'selected' : null }, f.name)));
      const descInp = h('textarea', { rows: 2, placeholder: 'Fresh red roses (12 stems)…' }, st.description);
      const tagsInp = h('input', { type: 'text', value: st.tags, placeholder: 'delivery, flowers, bestseller' });
      const capInp = h('textarea', { rows: 3, placeholder: 'Auto-composed if left blank. E.g. "Rose bouquet — ₹499"' }, st.caption);

      const body = h('div', { class: 'wacat-modal-body' },
        dropEl,
        h('div', { class: 'wacat-row2' },
          h('div', { class: 'wacat-field' }, h('label', {}, 'Name *'), nameInp),
          h('div', { class: 'wacat-field' }, h('label', {}, 'SKU / code'), skuInp),
          h('div', { class: 'wacat-field' }, h('label', {}, 'Price'), priceInp),
          h('div', { class: 'wacat-field' }, h('label', {}, 'Folder'), folderSel2)),
        h('div', { class: 'wacat-field' }, h('label', {}, 'Description'), descInp),
        h('div', { class: 'wacat-field' }, h('label', {}, 'Tags (comma-separated)'), tagsInp),
        h('div', { class: 'wacat-field' }, h('label', {}, 'Default caption (sent as WA message text)'), capInp)
      );

      const foot = h('div', { class: 'wacat-modal-foot' },
        existing ? h('button', { class: 'wacat-btn danger', onclick: async () => {
          if (!confirm('Delete "' + existing.name + '" from the catalogue?')) return;
          try {
            await api('api_wa_catalogue_delete', existing.id);
            toast('Deleted', 'ok'); modal.remove(); reload();
          } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
        } }, '🗑 Delete') : h('div'),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'wacat-btn ghost', onclick: () => modal.remove() }, 'Cancel'),
          h('button', { class: 'wacat-btn primary', onclick: async () => {
            if (!nameInp.value.trim()) return toast('Name required', 'err');
            if (!st.file_url) return toast('Please upload a file first', 'err');
            try {
              await api('api_wa_catalogue_upsert', {
                id: existing ? existing.id : undefined,
                name: nameInp.value.trim(),
                sku: skuInp.value.trim() || null,
                price: priceInp.value === '' ? null : Number(priceInp.value),
                description: descInp.value.trim() || null,
                caption: capInp.value.trim() || null,
                tags: tagsInp.value,
                folder_id: folderSel2.value || null,
                file_url: st.file_url,
                file_mime: st.file_mime,
                file_size: st.file_size
              });
              toast('Saved', 'ok'); modal.remove(); reload();
            } catch (e) { toast('Save failed: ' + e.message, 'err'); }
          } }, 'Save item'))
      );

      modal.appendChild(h('div', { class: 'wacat-modal' },
        h('div', { class: 'wacat-modal-head' },
          h('h3', {}, existing ? 'Edit item' : 'Add item to catalogue'),
          h('button', { class: 'wacat-btn ghost', onclick: () => modal.remove() }, '✕')),
        body, foot));
      document.body.appendChild(modal);
    }

    // ── Folders modal ──────────────────────────────────────────────────────
    function openFolders() {
      const modal = h('div', { class: 'wacat-modal-bg', onclick: e => { if (e.target === modal) modal.remove(); } });
      const list = h('div');
      function refreshList() {
        list.innerHTML = '';
        if (!state.folders.length) {
          list.appendChild(h('div', { class: 'wacat-empty' }, 'No folders yet'));
        } else state.folders.forEach(f => {
          list.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid #f1f5f9', borderRadius: '6px', marginBottom: '6px' } },
            h('div', {}, h('div', { style: { fontWeight: '600', fontSize: '13px' } }, f.name),
              h('div', { style: { fontSize: '11px', color: '#64748b' } }, (f.item_count || 0) + ' items')),
            h('div', { style: { display: 'flex', gap: '4px' } },
              h('button', { class: 'wacat-btn ghost', onclick: async () => {
                const nn = prompt('Rename folder to:', f.name);
                if (nn && nn.trim()) {
                  await api('api_wa_catalogue_folders_upsert', { id: f.id, name: nn.trim() });
                  reload(); refreshList();
                }
              } }, '✎'),
              h('button', { class: 'wacat-btn danger', onclick: async () => {
                if (confirm('Delete folder "' + f.name + '"? (Items will be moved to No folder.)')) {
                  await api('api_wa_catalogue_folders_delete', f.id);
                  reload(); refreshList();
                }
              } }, '🗑'))));
        });
      }
      refreshList();
      const newInp = h('input', { type: 'text', placeholder: 'e.g. Product photos' });
      modal.appendChild(h('div', { class: 'wacat-modal' },
        h('div', { class: 'wacat-modal-head' },
          h('h3', {}, '📁 Manage folders'),
          h('button', { class: 'wacat-btn ghost', onclick: () => modal.remove() }, '✕')),
        h('div', { class: 'wacat-modal-body' },
          list,
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '14px' } },
            newInp,
            h('button', { class: 'wacat-btn primary', onclick: async () => {
              if (!newInp.value.trim()) return;
              try {
                await api('api_wa_catalogue_folders_upsert', { name: newInp.value.trim() });
                newInp.value = '';
                await reload(); refreshList();
                toast('Folder added', 'ok');
              } catch (e) { toast('Failed: ' + e.message, 'err'); }
            } }, '+ Add folder')))
      ));
      document.body.appendChild(modal);
    }

    // ── CSV import modal ──────────────────────────────────────────────────
    function openImport() {
      const modal = h('div', { class: 'wacat-modal-bg', onclick: e => { if (e.target === modal) modal.remove(); } });
      const inp = h('input', { type: 'file', accept: '.csv,text/csv' });
      const status = h('div', { style: { marginTop: '10px', fontSize: '13px', color: '#475569' } });
      modal.appendChild(h('div', { class: 'wacat-modal' },
        h('div', { class: 'wacat-modal-head' },
          h('h3', {}, '📤 Bulk import from CSV'),
          h('button', { class: 'wacat-btn ghost', onclick: () => modal.remove() }, '✕')),
        h('div', { class: 'wacat-modal-body' },
          h('p', { style: { fontSize: '13px', color: '#475569', marginBottom: '12px' } },
            'CSV columns (header row required): ',
            h('code', { style: { background: '#f1f5f9', padding: '1px 5px', borderRadius: '3px' } },
              'name, sku, price, description, caption, file_url, tags, folder')),
          h('p', { style: { fontSize: '12px', color: '#64748b', marginBottom: '12px' } },
            '"file_url" must be a public HTTPS URL to the file (the catalogue will cache the WA media_id on first send).'),
          inp,
          status,
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '18px' } },
            h('button', { class: 'wacat-btn ghost', onclick: () => modal.remove() }, 'Cancel'),
            h('button', { class: 'wacat-btn primary', onclick: async () => {
              if (!inp.files || !inp.files[0]) return toast('Pick a CSV', 'err');
              try {
                const text = await inp.files[0].text();
                const rows = parseCsv(text);
                status.textContent = 'Importing ' + rows.length + ' rows…';
                const r = await api('api_wa_catalogue_import_csv', { rows });
                toast('Imported ' + r.inserted + ' items (' + r.skipped + ' skipped)', 'ok');
                modal.remove(); reload();
              } catch (e) { status.textContent = 'Failed: ' + e.message; }
            } }, 'Import')))
      ));
      document.body.appendChild(modal);
    }

    await reload();
  }

  // Minimal CSV parser (header row + comma-separated, quoted fields OK)
  function parseCsv(text) {
    const rows = [];
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return rows;
    const hdr = splitCsvLine(lines[0]).map(s => s.trim().toLowerCase());
    for (let i = 1; i < lines.length; i++) {
      const c = splitCsvLine(lines[i]);
      const row = {};
      hdr.forEach((k, ix) => row[k] = c[ix] == null ? '' : c[ix]);
      rows.push(row);
    }
    return rows;
  }
  function splitCsvLine(line) {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }
  function debounce(fn, ms) {
    let t; return function() { const args = arguments, ctx = this;
      clearTimeout(t); t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }

  // ── PICKER (used by chat composer) ────────────────────────────────────────
  function openPicker(opts) {
    _injectStyles();
    opts = opts || {};
    const state = { folders: [], items: [], search: '', folderId: '', picked: new Set() };
    const bg = h('div', { class: 'wacat-pick-wrap', onclick: e => { if (e.target === bg) bg.remove(); } });
    const box = h('div', { class: 'wacat-pick' });
    bg.appendChild(box);

    const head = h('div', { class: 'wacat-pick-head' },
      h('b', {}, '📚 Send from catalogue'),
      h('span', { style: { cursor: 'pointer', opacity: '.8' }, onclick: () => bg.remove() }, '✕'));
    const navBar = h('div', { class: 'wacat-pick-nav' });
    const searchWrap = h('div', { class: 'wacat-pick-search' });
    const bodyEl = h('div', { class: 'wacat-pick-body' });
    const footBar = h('div', { class: 'wacat-pick-foot' });
    box.appendChild(head); box.appendChild(navBar); box.appendChild(searchWrap); box.appendChild(bodyEl); box.appendChild(footBar);

    const searchInp = h('input', { placeholder: '🔍 Search name / SKU / tag…' });
    searchInp.addEventListener('input', debounce(() => { state.search = searchInp.value; reloadItems(); }, 250));
    searchWrap.appendChild(searchInp);

    async function reloadFolders() {
      try {
        const f = await api('api_wa_catalogue_folders_list').catch(() => ({ items: [] }));
        state.folders = f.items || [];
        renderNav();
      } catch (_) {}
    }
    async function reloadItems() {
      try {
        const i = await api('api_wa_catalogue_list', {
          folder_id: state.folderId || undefined,
          search: state.search || undefined,
          sort: 'popular'
        }).catch(() => ({ items: [] }));
        state.items = i.items || [];
        renderBody();
      } catch (_) {}
    }
    function renderNav() {
      navBar.innerHTML = '';
      const mk = (label, val) => {
        const c = h('div', { class: 'wacat-chip' + (state.folderId === val ? ' on' : ''),
          onclick: () => { state.folderId = val; renderNav(); reloadItems(); } }, label);
        navBar.appendChild(c);
      };
      mk('All', '');
      state.folders.forEach(f => mk(f.name + ' (' + (f.item_count || 0) + ')', String(f.id)));
    }
    function renderBody() {
      bodyEl.innerHTML = '';
      if (!state.items.length) {
        bodyEl.appendChild(h('div', { class: 'wacat-empty' },
          h('div', { style: { fontSize: '32px', marginBottom: '6px' } }, '📚'),
          h('div', {}, 'No items in catalogue. Add some from Marketing → 📚 WA Catalogue.')));
        renderFoot();
        return;
      }
      const grid = h('div', { class: 'wacat-grid', style: { border: '0', padding: '14px' } });
      state.items.forEach(item => {
        const thumb = _thumbSrc(item);
        const card = h('div', { class: 'wacat-item' + (state.picked.has(item.id) ? ' picked' : '') },
          h('div', { class: 'pick' }),
          h('div', { class: 'thumb' },
            thumb ? h('img', { src: thumb, alt: item.name, onerror: function() { this.replaceWith(document.createTextNode(emojiOf(item))); } }) : emojiOf(item)),
          item.price != null && item.price !== '' ? h('div', { class: 'badge' }, fmtPrice(item.price, item.currency)) : null,
          h('div', { class: 'info' },
            h('div', { class: 'name' }, item.name),
            h('div', { class: 'meta' }, (item.send_count > 0 ? 'Sent ' + item.send_count + '× · ' : '') + (item.folder_name || ''))));
        card.addEventListener('click', () => {
          if (state.picked.has(item.id)) state.picked.delete(item.id);
          else state.picked.add(item.id);
          card.classList.toggle('picked');
          renderFoot();
        });
        grid.appendChild(card);
      });
      bodyEl.appendChild(grid);
      renderFoot();
    }
    function renderFoot() {
      footBar.innerHTML = '';
      const picked = state.picked.size;
      const label = picked === 0 ? 'Pick one or more items to send'
                  : picked + ' item' + (picked !== 1 ? 's' : '') + ' selected';
      footBar.appendChild(h('div', { style: { fontSize: '12px', color: '#475569', fontWeight: '600' } }, label));
      footBar.appendChild(h('div', { style: { display: 'flex', gap: '6px' } },
        h('button', { class: 'wacat-btn ghost', onclick: () => bg.remove() }, 'Cancel'),
        h('button', { class: 'wacat-btn primary', disabled: picked === 0 ? 'disabled' : null,
          style: { opacity: picked === 0 ? '.5' : '1', pointerEvents: picked === 0 ? 'none' : 'auto' },
          onclick: async () => {
            try {
              const r = await api('api_wa_catalogue_send', {
                phone: opts.phone,
                from_phone_number_id: opts.from_phone_number_id,
                item_ids: Array.from(state.picked)
              });
              toast(r.sent + ' item' + (r.sent !== 1 ? 's' : '') + ' sent', 'ok');
              bg.remove();
              if (typeof opts.onSent === 'function') opts.onSent(r);
            } catch (e) { toast('Send failed: ' + e.message, 'err'); }
          } }, 'Send now →')));
    }

    document.body.appendChild(bg);
    reloadFolders();
    reloadItems();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.WA_CATALOGUE = { render: renderPage, openPicker: openPicker };

  /* WA_CATALOGUE_v1 — no sidebar entry. Access is via WhatsApp page sub-tab
   * (#/whatsbot/catalogue). Keep VIEWS + hashchange for direct-URL fallback. */
  function _selfRegister() {
    try {
      if (window.VIEWS && !window.VIEWS.wacatalogue) {
        window.VIEWS.wacatalogue = function () {
          const host = document.getElementById('view');
          if (host) renderPage(host);
        };
      }
    } catch (_) {}
  }
  function _tryAddSidebar_DISABLED() {
    try {
      // Only render for tenants that have the flag on.
      const flag = (window.CRM && window.CRM.brand && window.CRM.brand.WA_CATALOGUE_ENABLED)
                || (window.CRM && window.CRM.cfg && window.CRM.cfg.WA_CATALOGUE_ENABLED)
                || (window.APP && window.APP.brand && window.APP.brand.WA_CATALOGUE_ENABLED);
      if (String(flag || '') !== '1') return;
      // Look for a Marketing / Communication section link (data-page="templates" etc.)
      // and drop a sibling link after it. Retries every 500ms until sidebar exists.
      const existing = document.querySelector('a[href="#/wacatalogue"]');
      if (existing) return;
      const nav = document.querySelector('.sidebar, aside, nav');
      if (!nav) { setTimeout(_tryAddSidebar, 800); return; }
      const anchor = nav.querySelector('a[href="#/templates"], a[href="#/wabotflows"], a[href="#/reminderflows"]');
      const link = document.createElement('a');
      link.href = '#/wacatalogue';
      link.className = (anchor && anchor.className) || 'nav-link';
      link.textContent = '📚 WA Catalogue';
      link.style.cursor = 'pointer';
      if (anchor && anchor.parentElement) {
        anchor.parentElement.insertBefore(link, anchor.nextSibling);
      } else {
        nav.appendChild(link);
      }
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _selfRegister);
  else setTimeout(_selfRegister, 100);

  // Also react to hash changes for #/wacatalogue directly (belt + suspenders)
  window.addEventListener('hashchange', () => {
    if (String(location.hash || '').startsWith('#/wacatalogue')) {
      const host = document.getElementById('view');
      if (host) renderPage(host);
    }
  });
  if (String(location.hash || '').startsWith('#/wacatalogue')) {
    setTimeout(() => { const host = document.getElementById('view'); if (host) renderPage(host); }, 500);
  }
})();
