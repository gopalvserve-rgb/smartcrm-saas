/**
 * caller-id-native.js
 *
 * Loaded inside the Capacitor wrapper (and a no-op in the browser PWA).
 * Wires the native CallerId plugin events to:
 *   - /api/calls/lookup        (when the phone starts ringing)
 *   - /api/calls/handleEnded   (when the call ends or is missed)
 *   - /api/recordings          (when the OEM dialer drops a new audio file)
 *
 * The native side renders a "minimal" notification immediately. As soon
 * as the lookup returns we ask the native side to redraw the notification
 * with rich content. So the rep sees a popup the moment the phone rings,
 * even on a flaky connection.
 */
(function(){
  // Skip outside Capacitor — this is loaded by every page but only
  // means anything on the native wrapper.
  const isCap = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isCap) return;

  const CallerId = window.Capacitor.Plugins.CallerId;
  if (!CallerId) {
    console.warn('[caller-id] native plugin missing — running on Capacitor without CallerIdPlugin registered');
    return;
  }

  // Track the most recent inbound call so the recording-observer event
  // can attach the audio bytes to the right lead.
  let lastCall = null;     // { phone, leadId, startedAt }

  // ---- 1. Phone starts ringing ----------------------------------
  CallerId.addListener('callRinging', async ({ phone, ts }) => {
    console.log('[caller-id] ringing', phone);
    if (typeof toast === 'function') toast('📞 Incoming: ' + phone);
    lastCall = { phone, leadId: null, customerId: null, startedAt: ts };
    try {
      const r = await fetch('/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fn: 'api_call_lookup',
          args: [_token(), phone]
        })
      }).then(r => r.json());
      if (r && r.ok && r.result && r.result.match) {
        const m = r.result;
        lastCall.leadId = m.kind === 'lead' ? m.id : null;
        lastCall.customerId = m.kind === 'customer' ? m.id : null;
        // Compose the rich notification body
        const lines = [];
        const headline = m.kind === 'customer'
          ? `${m.name} · ${m.status || 'customer'}`
          : `${m.name}${m.status ? ' · ' + m.status : ''}${m.qualified ? ' · ⭐' : ''}`;
        if (m.kind === 'customer') {
          if (m.lifetime_value) lines.push('LTV: ₹' + Number(m.lifetime_value).toLocaleString('en-IN'));
          if (m.next_renewal_at) lines.push('Renews: ' + String(m.next_renewal_at).slice(0, 10));
          if (m.total_purchases) lines.push('Buys: ' + m.total_purchases);
        } else {
          if (m.value) lines.push('Value: ₹' + Number(m.value).toLocaleString('en-IN'));
          if (m.assigned_name) lines.push('Owner: ' + m.assigned_name);
          if (m.next_followup_at) lines.push('FU: ' + new Date(m.next_followup_at).toLocaleString('en-IN'));
        }
        if (m.tags) lines.push('Tags: ' + m.tags);
        if (m.recent_remarks && m.recent_remarks.length) {
          lines.push('');
          lines.push('Recent:');
          m.recent_remarks.slice(0, 2).forEach(r => {
            lines.push('• ' + String(r.remark).slice(0, 80));
          });
        }
        await CallerId.showLeadNotification({
          title: '📞 ' + headline,
          body: lines.join('\n'),
          deeplink: m.url || '/'
        });
      } else {
        await CallerId.showLeadNotification({
          title: '📞 New caller',
          body: phone + '\n\nNot in CRM yet — will auto-create after the call.',
          deeplink: '/#/leads'
        });
      }
    } catch (e) {
      console.warn('[caller-id] lookup failed', e);
    }
  });

  // ---- 2. Call ended (or was missed) -----------------------------
  CallerId.addListener('callEnded', async ({ phone, duration_s, direction, ts }) => {
    console.log('[caller-id] call ended', phone, direction, duration_s + 's');
    if (typeof toast === 'function') {
      toast('📴 Call ' + (direction === 'missed' ? 'missed' : 'ended') + ': ' + phone + ' · ' + duration_s + 's');
    }
    try {
      const r = await fetch('/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fn: 'api_call_handleEnded',
          args: [_token(), {
            phone,
            direction,
            duration_s,
            started_at: lastCall ? new Date(lastCall.startedAt).toISOString() : new Date(ts).toISOString()
          }]
        })
      }).then(r => r.json());
      if (r && r.ok && r.result) {
        // Update lastCall with the lead_id (might have been auto-created
        // by the server) so the recording uploader can attach to it.
        if (r.result.lead_id) {
          lastCall = lastCall || { phone, startedAt: ts };
          lastCall.leadId = r.result.lead_id;
        }
        // Surface a quick toast in the wrapped app if open
        if (typeof toast === 'function') {
          if (r.result.auto_created) toast('New lead created from inbound call');
          else if (r.result.followup_scheduled) toast('Callback scheduled for tomorrow');
        }
      }
    } catch (e) {
      console.warn('[caller-id] handleEnded failed', e);
    }
  });

  // ---- 3. New call recording detected on disk -------------------
  CallerId.addListener('recordingAvailable', async ({ path, name, ts }) => {
    console.log('[caller-id] recording available', path);
    if (typeof toast === 'function') toast('🎙 Recording detected: ' + name);
    // Don't bail when lastCall is missing — still upload the file. The server
    // will parse the filename and match by timestamp against recent call_events.
    // This handles two real-world cases:
    //   1. App was killed when the call happened (no PhoneStateReceiver fire)
    //   2. Filename has just a contact name (no phone digits)
    let parsed = null;
    try {
      if (typeof window.parseRecordingFilename === 'function') {
        parsed = window.parseRecordingFilename(name, ts);
      }
    } catch (_) {}
    const phone = (lastCall && lastCall.phone) || (parsed && parsed.phone) || '';
    const startedAt = (lastCall && lastCall.startedAt) || (parsed && parsed.startedAt) || ts;
    try {
      const Filesystem = window.Capacitor.Plugins.Filesystem;
      if (!Filesystem) throw new Error('Filesystem plugin missing');
      const result = await Filesystem.readFile({ path });
      const blob = _b64ToBlob(result.data, _mimeFor(name));
      const fd = new FormData();
      fd.append('audio', blob, name);
      fd.append('filename', name);              // server uses this to re-parse if needed
      fd.append('phone', phone);
      fd.append('direction', (lastCall && lastCall.direction) || 'in');
      fd.append('duration_s', String((lastCall && lastCall.duration_s) || 0));
      if (lastCall && lastCall.leadId) fd.append('lead_id', String(lastCall.leadId));
      fd.append('device_path', path);
      fd.append('started_at', new Date(startedAt).toISOString());
      // Hints from the filename — used by the server to fall back when phone is empty.
      if (parsed && parsed.contact)  fd.append('contact_hint', parsed.contact);
      if (parsed && parsed.lastFour) fd.append('lastfour_hint', parsed.lastFour);
      const r = await fetch('/api/recordings', {
        method: 'POST',
        headers: { 'x-auth-token': _token() },
        body: fd
      });
      const j = await r.json().catch(() => ({}));
      if (typeof toast === 'function') {
        if (j && j.ok && j.lead_id) toast('Call recording attached to lead #' + j.lead_id);
        else if (j && j.ok)         toast('Recording uploaded — no lead matched yet');
        else                         toast('Recording upload failed');
      }
    } catch (e) {
      console.warn('[caller-id] upload recording failed', e);
    }
  });

  // ---- 4. Start listening once the user is logged in -----------
  //
  // Boot flow design notes:
  //
  //  • CallerId.start() resolves with { ok, listening } — even on a
  //    permission *denial* the Promise still resolves, with ok:false.
  //    The previous code only handled .catch(), so a denied permission
  //    silently triggered the SUCCESS toast which is confusing.
  //
  //  • The CRM works fine without Caller ID. A permission denial is
  //    NOT a hard failure and shouldn't look like one. Earlier we
  //    shipped a big orange "Caller ID failed — open Settings → …"
  //    toast that made users think the whole app had crashed.
  //    Replacing with a softer, dismissable one-time banner.
  //
  //  • `crm_callerid_nag_v1` in localStorage = permanent dismissal.
  //
  function tryStart() {
    if (!_token()) {
      // Not logged in yet — wait for it
      setTimeout(tryStart, 2000);
      return;
    }
    CallerId.start().then(r => {
      console.log('[caller-id] start result', r);
      if (r && r.ok === false) {
        _showCallerIdNudgeOnce();
        return;
      }
      if (!sessionStorage.getItem('crm_callerid_announced_v1')) {
        try { sessionStorage.setItem('crm_callerid_announced_v1', '1'); } catch (_) {}
        if (typeof toast === 'function') {
          toast('📞 Caller ID active — incoming calls will auto-log');
        }
      }
    }).catch(e => {
      console.warn('[caller-id] start failed', e);
      _showCallerIdNudgeOnce();
    });
  }

  function _showCallerIdNudgeOnce() {
    try {
      if (localStorage.getItem('crm_callerid_nag_v1') === '1') return;
    } catch (_) {}
    if (document.querySelector('.crm-callerid-nudge')) return;
    const host = document.body || document.documentElement;
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.className = 'crm-callerid-nudge';
    wrap.style.cssText = 'position:fixed;left:12px;right:12px;bottom:84px;z-index:9998;background:#1e293b;color:#f1f5f9;border:1px solid #334155;border-left:4px solid #6366f1;border-radius:10px;padding:.85rem 1rem;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:.88rem;line-height:1.45;display:flex;flex-direction:column;gap:.65rem;';
    wrap.innerHTML =
      '<div style="font-weight:600;color:#f8fafc">📞 Optional: enable Caller ID</div>' +
      '<div style="color:#cbd5e1">Grant <b>Phone</b>, <b>Notifications</b>, and <b>Audio</b> permissions to see lead details when a customer calls. The CRM works fine either way — this only powers the popup card on incoming calls.</div>' +
      '<div style="display:flex;gap:.5rem;flex-wrap:wrap;justify-content:flex-end">' +
      '  <button class="cid-skip" style="background:transparent;color:#94a3b8;border:0;padding:.4rem .75rem;font:inherit;cursor:pointer">Don\'t show again</button>' +
      '  <button class="cid-later" style="background:#334155;color:#f1f5f9;border:0;padding:.4rem .9rem;border-radius:6px;font:inherit;cursor:pointer">Later</button>' +
      '  <button class="cid-open" style="background:#6366f1;color:#fff;border:0;padding:.4rem .9rem;border-radius:6px;font:inherit;cursor:pointer;font-weight:600">Open Settings</button>' +
      '</div>';
    host.appendChild(wrap);

    function _gone() { try { wrap.remove(); } catch (_) {} }
    wrap.querySelector('.cid-later').onclick = _gone;
    wrap.querySelector('.cid-skip').onclick = function () {
      try { localStorage.setItem('crm_callerid_nag_v1', '1'); } catch (_) {}
      _gone();
    };
    wrap.querySelector('.cid-open').onclick = function () {
      try {
        // Each tenant's APK has its own package id, so we ask Capacitor
        // for the running app's id at runtime instead of hardcoding.
        const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
        if (App && typeof App.getInfo === 'function' && typeof App.openUrl === 'function') {
          App.getInfo().then(info => {
            const pkg = (info && info.id) || '';
            if (pkg) App.openUrl({ url: 'package:' + pkg }).catch(() => {});
          }).catch(() => {});
        }
      } catch (_) {}
      _gone();
    };
  }
  tryStart();

  // ---- helpers ------------------------------------------------
  function _token() {
    return localStorage.getItem('crm_token') || '';
  }
  function _b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const len = bin.length;
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime || 'application/octet-stream' });
  }
  function _mimeFor(name) {
    const lc = String(name || '').toLowerCase();
    if (lc.endsWith('.m4a') || lc.endsWith('.aac')) return 'audio/m4a';
    if (lc.endsWith('.mp3')) return 'audio/mpeg';
    if (lc.endsWith('.amr')) return 'audio/amr';
    if (lc.endsWith('.3gp')) return 'audio/3gpp';
    if (lc.endsWith('.wav')) return 'audio/wav';
    if (lc.endsWith('.ogg')) return 'audio/ogg';
    return 'application/octet-stream';
  }
})();
