const CACHE_NAME = 'es-showroom-v1'; // sera remplacé dynamiquement par le serveur

const STATIC_ASSETS = [
  '/logo.svg',
  '/editions-showroom-b2b-portail',
  '/portal-login.html'
  // NB : les polices Google ne sont PAS pré-cachées ici — la CSP (connect-src 'self')
  // bloque tout fetch cross-origin du service worker. Le navigateur les charge
  // directement via le <link> (autorisé par style-src/font-src).
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

  // Ne PAS intercepter les requêtes cross-origin (Google Fonts, jsdelivr…) : le
  // fetch() du service worker est régi par connect-src 'self' et serait bloqué,
  // cassant le chargement. On laisse le navigateur les charger directement (le
  // <link>/<script> sont autorisés par style-src/font-src/script-src).
  if (url.origin !== self.location.origin) return;

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

// Push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  const { title, body } = e.data.json();
  e.waitUntil(self.registration.showNotification(title, {
    body, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [200, 100, 200]
  }));
});
