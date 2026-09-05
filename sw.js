const CACHE = 'reawaken-v13';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './fonts/BarlowSemiCondensed-Bold.ttf',
  './js/app.js',
  './js/profile.js',
  './js/exercise-info.js',
  './js/db.js',
  './js/routine.js',
  './js/routine-parser.js',
  './js/inbody.js',
  './js/sync.js',
  './data/seed-measures.json',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(asset => new Request(asset, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('reawaken-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first con fallback a caché: siempre usable sin señal en el gym.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const navigation = e.request.mode === 'navigate';
  if (!navigation && !ASSETS.some(asset => new URL(asset, self.location.href).pathname === url.pathname)) return;
  url.search = '';
  const key = navigation ? new URL('./index.html', self.location.href).href : url.href;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cached ? 4000 : 15000);
    try {
      const response = await fetch(e.request, { cache: 'no-cache', signal: controller.signal });
      if (response.ok) await cache.put(key, response.clone()).catch(() => {});
      return response;
    } catch {
      return cached || Response.error();
    } finally {
      clearTimeout(timeout);
    }
  })());
});
