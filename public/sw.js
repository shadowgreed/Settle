// Settle service worker — v4
// Cache strategy by request type:
//   /static/js|css|media  → cache-first  (content-hashed, never change)
//   /api/                 → network-only (app-level caching handles these)
//   cross-origin          → pass-through (TMDB images, analytics, etc.)
//   navigation (HTML)     → network-first, cache fallback → /index.html

const SHELL_CACHE  = 'settle-shell-v4';
const STATIC_CACHE = 'settle-static-v4';
const ALL_CACHES   = [SHELL_CACHE, STATIC_CACHE];

// App shell — pre-cached on install so the app loads offline immediately
const PRECACHE_URLS = ['/', '/index.html', '/manifest.json'];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(PRECACHE_URLS))
  );
});

// ── Activate — evict old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => !ALL_CACHES.includes(k)).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Cross-origin — pass through untouched (TMDB images, PostHog, Vercel analytics)
  if (url.origin !== self.location.origin) return;

  // 2. API proxy calls — skip SW, let the app's own in-memory cache handle them
  if (url.pathname.startsWith('/api/')) return;

  // 3. Static assets (CRA outputs to /static/ with content-hash filenames)
  //    Cache-first: once cached they never need re-fetching until the hash changes.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            // Only cache valid responses
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached); // if offline and uncached, fail gracefully
        })
      )
    );
    return;
  }

  // 4. Everything else (navigation, manifest, icons) — network-first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Keep the shell cache fresh on successful navigation
        if (event.request.mode === 'navigate' && response.ok) {
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, response.clone()));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request)
          // SPA fallback — any offline navigation serves index.html
          .then(cached => cached || caches.match('/index.html'))
      )
  );
});
