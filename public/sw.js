const CACHE_NAME = 'settle-v2';

// On install — cache the app shell
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html'])
    )
  );
});

// On activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback.
// IMPORTANT: only intercept same-origin requests.
// Cross-origin requests (TMDB images, analytics, PostHog, etc.) are left alone
// so the browser handles them directly without a service-worker round-trip.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Let cross-origin requests (images, APIs, analytics) pass through untouched
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful navigation responses (the app shell)
        if (event.request.mode === 'navigate') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(cached =>
          cached || new Response('Offline', { status: 503, statusText: 'Offline' })
        )
      )
  );
});
