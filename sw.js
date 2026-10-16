const CACHE = 'reawaken-v50';
const ASSETS = [
  './',
  './index.html',
  './favicon.svg',
  './css/styles.css',
  './fonts/BarlowSemiCondensed-Bold.ttf',
  './js/app.js',
  './js/motion.js',
  './js/profile.js',
  './js/progress.js',
  './js/intelligence.js',
  './js/session-history.js',
  './js/personal-records.js',
  './js/training-preferences.js',
  './js/routine-generator.js',
  './js/training-ui.js',
  './js/exercise-info.js',
  './js/exercise-catalog.js',
  './js/db.js',
  './js/backup.js',
  './js/routine.js',
  './js/routine-parser.js',
  './js/routine-pdf.js',
  './js/vendor/pdfjs/build/pdf.mjs',
  './js/vendor/pdfjs/build/pdf.worker.mjs',
  './js/inbody.js',
  './js/sync.js',
  './data/seed-measures.json',
  './data/guide-pdf.png',
  './data/guide-load.png',
  './data/guide-inbody.png',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/trophy.svg',
  './icons/clipboard-check.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/launch-portrait-dark.png',
  './icons/launch-portrait-light.png',
  './icons/launch-landscape-dark.png',
  './icons/launch-landscape-light.png',
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
  e.waitUntil(pruneRetiredCaches().then(() => self.clients.claim()));
});

async function pruneRetiredCaches() {
  const version = Number(CACHE.match(/-v(\d+)$/)[1]);
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => {
    const match = key.match(/^reawaken-v(\d+)$/);
    return match && Number(match[1]) < version;
  }).map(key => caches.delete(key)));
}

// Network-first con fallback a caché: siempre usable sin señal en el gym.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || e.request.cache === 'no-store') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const navigation = e.request.mode === 'navigate';
  if (!navigation && !ASSETS.some(asset => new URL(asset, self.location.href).pathname === url.pathname)) return;
  url.search = '';
  const key = navigation ? new URL('./index.html', self.location.href).href : url.href;
  e.respondWith((async () => {
    await pruneRetiredCaches().catch(error => console.warn('No se pudieron retirar las cachés antiguas.', error));
    // Solo install crea la cache: un fetch tardío no puede resucitar una versión retirada.
    const cached = await caches.match(key, { cacheName: CACHE });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cached ? 4000 : 15000);
    try {
      const response = await fetch(e.request, { cache: 'no-cache', signal: controller.signal });
      return response.ok ? response : cached || response;
    } catch {
      return cached || Response.error();
    } finally {
      clearTimeout(timeout);
    }
  })());
});
