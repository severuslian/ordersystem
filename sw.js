const CACHE = 'sl-orders-20260326154634';

// Install: skip waiting immediately
self.addEventListener('install', e => {
  self.skipWaiting();
});

// Activate: delete ALL old caches and take control
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: NEVER cache HTML files, always go to network
self.addEventListener('fetch', e => {
  // Skip non-GET
  if (e.request.method !== 'GET') return;
  // Skip Supabase
  if (e.request.url.includes('supabase.co')) return;
  // NEVER cache HTML — always fresh from network
  if (e.request.url.includes('.html') || e.request.url.endsWith('/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // For JS/CSS/fonts: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
