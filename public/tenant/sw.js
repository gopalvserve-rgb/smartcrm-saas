/**
 * SW_KILL_SWITCH_v1 (2026-05-23)
 *
 * The tenant SPA's index.html no longer registers a service worker
 * (that registration was disabled when /t/<slug>/ scope handling
 * couldn't be done cleanly). However, devices that opened the app
 * BEFORE that change still have the previous SW alive and intercepting
 * requests — serving stale cached app.js / index.html and making it
 * impossible to receive updates without a manual cache wipe.
 *
 * This file replaces the old SW with a one-time killer:
 *
 *   - On `install`: skipWaiting() so this kill-version activates immediately.
 *   - On `activate`: delete every cache, then unregister itself, then
 *                    refresh every open client window so they pick up the
 *                    real (network-fetched) index.html + app.js.
 *   - `fetch` handler intentionally passes through to the network with
 *     NO caching while the unregister is in flight.
 *
 * Once every device has loaded this once, the SW is gone and future
 * loads talk to the network directly — exactly what we want now that
 * SW registration is disabled in index.html.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      // 1. Nuke every cache.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}

    try {
      // 2. Unregister this service worker.
      await self.registration.unregister();
    } catch (_) {}

    try {
      // 3. Tell every controlled client to reload so they fetch fresh
      //    HTML + JS from the network (no SW in front of them anymore).
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        try { c.navigate(c.url); } catch (_) {
          try { c.postMessage({ type: 'sw-reload' }); } catch (__) {}
        }
      }
    } catch (_) {}
  })());
});

// While the SW is still in control, never serve from cache — always
// pass through to network. After the activate handler runs the SW is
// unregistered so this handler stops firing entirely.
self.addEventListener('fetch', (event) => {
  // Intentionally do not call event.respondWith — letting the browser
  // do its default network fetch is what we want during the wind-down.
});
