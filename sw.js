const CACHE = 'streamfield-v9';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/vendor/supabase.js',
  './js/storage.js',
  './js/api.js',
  './js/addons.js',
  './js/stremio.js',
  './js/account.js',
  './js/player.js',
  './js/app.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        ASSETS.map((asset) =>
          fetch(asset, { cache: 'reload' }).then((res) => cache.put(asset, res))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin app shell requests; let addon API calls pass
  // through to the network untouched.
  if (url.origin !== location.origin) return;
  // Network-first so deploys propagate without a cache-version bump; the
  // cache is the offline fallback (and gets refreshed on every online load).
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
