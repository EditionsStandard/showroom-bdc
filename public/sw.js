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

  // Données privées buyer (commandes, messages, favoris, prix négociés, page
  // /portal elle-même…) : network-only, JAMAIS mises en Cache Storage. Sinon,
  // sur un appareil partagé (tablette showroom), une coupure réseau juste après
  // un changement de compte pourrait re-servir les données de l'acheteur
  // précédent depuis le cache (le cache-fallback générique ci-dessous les
  // aurait sinon capturées comme n'importe quelle réponse GET same-origin).
  // /api/me inclus : utilisé par commande.html (detectAgentMode) pour afficher le
  // nom/rôle de l'agent connecté — sur un appareil de vente partagé, une coupure
  // réseau juste après le changement d'agent pourrait sinon réafficher l'identité
  // de l'agent précédent depuis le cache générique ci-dessous.
  // /api/public/brands/:brandId, /commande, /api/selection, /selection : même
  // risque — catalogue et prix wholesale protégés par un token de lien de
  // commande ou de sélection, revérifié en base à chaque requête (voir
  // hasCommandeAccess ci-dessus côté serveur). Une révocation de lien ne doit
  // pas pouvoir être contournée par une coupure réseau qui re-sert la version
  // mise en cache avant révocation.
  if (url.pathname.startsWith('/api/portal') || url.pathname === '/portal' || url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/admin') || url.pathname.startsWith('/api/staff') || url.pathname === '/api/me' || url.pathname.startsWith('/api/public/brands') || url.pathname.startsWith('/commande') || url.pathname.startsWith('/api/selection') || url.pathname.startsWith('/selection')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // API CGV : Network-first, cache fallback (contenu public, pas sensible)
  if (url.pathname === '/api/public/cgv') {
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

// Message: trigger sync check from page ; CLEAR_CACHE purge tout le Cache
// Storage (appelé à la déconnexion buyer, en plus de l'exclusion réseau-only
// ci-dessus — défense en profondeur si un ancien SW moins récent est encore actif).
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'CLEAR_CACHE') {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  }
});

// Push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  const { title, body } = e.data.json();
  e.waitUntil(self.registration.showNotification(title, {
    body, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [200, 100, 200]
  }));
});
