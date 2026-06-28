const CACHE_NAME = 'es-showroom-v1'; // sera remplacé dynamiquement par le serveur

const STATIC_ASSETS = [
  '/logo.svg',
  '/editions-showroom-b2b-portail',
  '/portal-login.html',
  'https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap'
];

// Install: pre-cache static assets
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

// Activate: clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept POST requests (orders go through the offline queue in the page)
  if (e.request.method !== 'GET') return;

  // Ignorer les schémas non-http (chrome-extension://, etc.) — non cachables
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // API brand/products: Network-first, cache fallback
  if (url.pathname.startsWith('/api/public/brands') || url.pathname === '/api/public/cgv') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const clone = r.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets + HTML pages: Network-first, cache fallback
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

// Message: trigger sync check from page
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
