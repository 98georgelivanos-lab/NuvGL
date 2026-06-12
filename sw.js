const CACHE = 'streamfield-v6';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/storage.js',
  './js/api.js',
  './js/addons.js',
  './js/stremio.js',
  './js/simkl.js',
  './js/account.js',
  './js/player.js',
  './js/app.js',
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
  // Only cache same-origin app shell requests; let addon API calls pass through to the network.
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
