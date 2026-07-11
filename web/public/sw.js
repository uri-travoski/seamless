/* Seamless service worker: offline app shell + web push */
const SHELL_CACHE = 'seamless-shell-v1';
const RUNTIME_CACHE = 'seamless-runtime-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  // never cache API/JMAP/pixel traffic
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/jmap') || url.pathname.startsWith('/t/')) return;

  // hashed build assets: cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit ?? fetch(event.request).then((res) => {
        // only cache real assets, never an error/fallback page
        if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })),
    );
    return;
  }

  // navigations: network-first, fall back to cached shell for offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/')),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'New mail', body: '', tag: 'mail' };
  try { data = { ...data, ...event.data.json() }; } catch { /* keep defaults */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
