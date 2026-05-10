/**
 * Service worker — offline shell + Web Push.
 *
 * Caching:
 * - Network-first for the app shell; cache is only a fallback when offline.
 * - /api and /hook requests always go to the network — never cached.
 *
 * Web Push:
 * - Listens for `push` events and shows a native OS notification (banner +
 *   sound + vibration). Works even when the app/browser is fully closed,
 *   exactly like SMS — provided the user granted Notification permission.
 * - Tapping the notification focuses an open CRM tab if there is one,
 *   otherwise opens a new one at the URL the push payload specifies.
 */
const CACHE = 'lead-crm-shell-v167';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API / hook / setup / config / csv — always network, never cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' ||
      url.pathname.startsWith('/hook/') || url.pathname === '/setup' ||
      url.pathname === '/config.json') {
    return;
  }

  // Shell: network-first. Cache is only a fallback when offline.
  ev.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(req))
  );
});

// ---- Web Push handlers ---------------------------------------------

self.addEventListener('push', ev => {
  let data = {};
  try { data = ev.data ? ev.data.json() : {}; } catch (_) {
    try { data = { title: 'Lead CRM', body: ev.data ? ev.data.text() : '' }; } catch (__) {}
  }
  const title = data.title || '🔔 Lead CRM';
  const opts = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || ('crm-' + Date.now()),
    data: { url: data.url || '/' },
    // Android replays the OS sound + vibration pattern, mirroring an SMS.
    vibrate: [120, 60, 120, 60, 200],
    requireInteraction: !!data.sticky,
    renotify: true
  };
  ev.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const targetUrl = (ev.notification.data && ev.notification.data.url) || '/';
  ev.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If a CRM tab is already open, focus it and tell it to navigate.
    for (const client of all) {
      try {
        const u = new URL(client.url);
        if (u.origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: 'navigate', url: targetUrl });
          return;
        }
      } catch (_) {}
    }
    // Otherwise open a fresh window.
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
