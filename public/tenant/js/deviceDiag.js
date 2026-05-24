/* DEVICE_DIAG_v1 — phone-side telemetry. Posts batched events via the JSON
 * dispatcher (POST /api with { fn: 'api_devicediag_ingest', args }).
 * Pure additive — does NOT touch the locked recording sync pipeline.
 */
(function () {
  'use strict';

  function getToken() {
    try { return localStorage.getItem('token') || localStorage.getItem('jwt') || null; }
    catch (e) { return null; }
  }

  var QUEUE_KEY = 'deviceDiag.queue';
  var DEVICE_ID_KEY = 'deviceDiag.deviceId';

  function getDeviceId() {
    var id = null;
    try { id = localStorage.getItem(DEVICE_ID_KEY); } catch (e) {}
    if (!id) {
      id = 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {}
    }
    return id;
  }
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') || []; }
    catch (e) { return []; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify((q || []).slice(-100))); }
    catch (e) {}
  }
  function enqueue(ev) {
    var q = loadQueue();
    q.push(Object.assign({ created_at_ms: Date.now() }, ev || {}));
    saveQueue(q);
  }

  async function permissionState(name) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        var r = await navigator.permissions.query({ name: name });
        return r && r.state;
      }
    } catch (e) {}
    return null;
  }
  async function capacitorInfo() {
    try {
      var Cap = window.Capacitor;
      if (!Cap || !Cap.Plugins) return null;
      var out = {};
      try {
        if (Cap.Plugins.Device && Cap.Plugins.Device.getInfo) {
          var info = await Cap.Plugins.Device.getInfo();
          out.device = {
            model: info.model, manufacturer: info.manufacturer,
            platform: info.platform, osVersion: info.osVersion,
            appVersion: info.appVersion, appBuild: info.appBuild,
            isVirtual: info.isVirtual, name: info.name
          };
        }
      } catch (e) {}
      try {
        if (Cap.Plugins.Device && Cap.Plugins.Device.getBatteryInfo) {
          out.battery = await Cap.Plugins.Device.getBatteryInfo();
        }
      } catch (e) {}
      try {
        if (Cap.Plugins.Network && Cap.Plugins.Network.getStatus) {
          out.network = await Cap.Plugins.Network.getStatus();
        }
      } catch (e) {}
      return out;
    } catch (e) { return null; }
  }
  function breadcrumbsFromLocalStorage() {
    var ls = window.localStorage;
    var keys = [
      'rec_last_sync_at', 'rec_last_sync_count', 'rec_last_sync_error', 'rec_last_sync_url',
      'call_last_event_at', 'call_last_event_type', 'call_last_event_phone',
      'rec_folder_uri', 'rec_folder_files_count',
      'wb_last_token_refresh_at'
    ];
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      try { var v = ls.getItem(k); if (v != null) out[k] = v; } catch (e) {}
    }
    return out;
  }
  function tenantSlug() {
    try {
      var m = location.pathname.match(/^\/t\/([^/]+)/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  async function buildSnapshot(reason) {
    var perms = await Promise.all([
      permissionState('microphone'),
      permissionState('geolocation'),
      permissionState('notifications')
    ]);
    var cap = await capacitorInfo();
    return {
      reason: reason || 'snapshot',
      ua: navigator.userAgent,
      online: navigator.onLine,
      visibility: document.visibilityState,
      perms: { microphone: perms[0], geolocation: perms[1], notifications: perms[2] },
      capacitor: cap,
      breadcrumbs: breadcrumbsFromLocalStorage(),
      tenant_slug: tenantSlug(),
      v: '1'
    };
  }

  var _flushing = false;
  var _backoffMs = 0;
  function apiUrl() {
    var slug = tenantSlug();
    return slug ? ('/t/' + encodeURIComponent(slug) + '/api') : '/api';
  }

  async function flush() {
    if (_flushing) return;
    var tok = getToken();
    if (!tok) return;
    var q = loadQueue();
    if (!q.length) return;
    _flushing = true;
    try {
      var body = JSON.stringify({
        fn: 'api_devicediag_ingest',
        args: { device_id: getDeviceId(), events: q.slice(0, 50) }
      });
      var r = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: body
      });
      if (r.ok) {
        saveQueue(q.slice(50));
        _backoffMs = 0;
      } else {
        _backoffMs = Math.min((_backoffMs || 5000) * 2, 5 * 60 * 1000);
      }
    } catch (e) {
      _backoffMs = Math.min((_backoffMs || 5000) * 2, 5 * 60 * 1000);
    } finally {
      _flushing = false;
    }
  }

  async function emitAppOpen() {
    enqueue({ event_type: 'app_open', step: 'app_open', severity: 'info',
              payload: await buildSnapshot('app_open') });
    flush();
  }
  async function emitHeartbeat() {
    enqueue({ event_type: 'heartbeat', step: 'heartbeat', severity: 'info',
              payload: await buildSnapshot('heartbeat') });
  }
  async function emitResume() {
    enqueue({ event_type: 'resume', step: 'app_open', severity: 'info',
              payload: await buildSnapshot('resume') });
    flush();
  }

  setTimeout(function () { try { emitAppOpen(); } catch (e) {} }, 1500);
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    try { emitHeartbeat(); } catch (e) {}
  }, 60 * 1000);
  setInterval(function () {
    if (_backoffMs > 0) { _backoffMs -= 30000; if (_backoffMs > 0) return; }
    try { flush(); } catch (e) {}
  }, 30 * 1000);

  var _lastVisibleAt = Date.now();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (Date.now() - _lastVisibleAt > 2 * 60 * 1000) {
        try { emitResume(); } catch (e) {}
      }
      _lastVisibleAt = Date.now();
    } else {
      _lastVisibleAt = Date.now();
    }
  });

  window.addEventListener('pagehide', function () {
    try {
      var tok = getToken();
      var q = loadQueue();
      if (!tok || !q.length) return;
      fetch(apiUrl(), {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify({
          fn: 'api_devicediag_ingest',
          args: { device_id: getDeviceId(), events: q.slice(0, 50) }
        })
      }).catch(function () {});
    } catch (e) {}
  });

  window.__deviceDiag = {
    flush: flush,
    queueLen: function () { return loadQueue().length; },
    deviceId: getDeviceId(),
    snapshot: async function () { return await buildSnapshot('manual'); }
  };
})();
