const CACHE_NAME = 'ollama-ui-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico'
];

// Install: Cache all core application shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching core shell assets.');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: Purge obsolete dynamic assets from prior cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Evicting deprecated cache profile:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Coordinate network requests vs. offline cached assets
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // Exclude local Ollama API endpoints (never cache real-time model completions)
  if (requestUrl.pathname.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-First, falling back to Network strategy
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetch(event.request).then((networkResponse) => {
        // Dynamically cache runtime Angular lazy bundles and scripts (js, css, fonts, etc.)
        if (
          networkResponse.status === 200 &&
          (event.request.destination === 'script' ||
            event.request.destination === 'style' ||
            event.request.destination === 'image' ||
            event.request.destination === 'font')
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    }).catch(() => {
      // Angular client-side router fallback: Serve index.html if nav offline
      if (event.request.mode === 'navigate') {
        return caches.match('/index.html');
      }
    })
  );
});
