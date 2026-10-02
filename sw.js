// Offline shell for 数间. Two rules decide the whole file:
//
// 1. Same-origin subresources are **network-first, cache-fallback**. A hand-written VERSION
//    plus cache-first would pin js/css to whatever was cached on the first visit, so shipping
//    a new index.html against old modules is exactly the "half-updated app" ghost state this
//    cache strategy has been caught creating in other repos. The version number only ever
//    guards the *shell* precache and the sweep of stale caches on activate.
// 2. Nothing here throws on file://. The Electron window loads the same tree from disk, where
//    service workers are unavailable; registration is gated in js/main.js by protocol, and this
//    file simply never runs there.

const VERSION = 'shikaku-v1';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

// The shell is what a cold offline start needs to reach the menu; the engine modules are
// pulled in by the page itself and land in RUNTIME on first use.
const PRECACHE = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './assets/img/paper-256.png',
  './assets/img/spark-64.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(SHELL).then((c) => Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => null)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(`${VERSION}-`)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const sameOrigin = (url) => url.origin === self.location.origin;

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!sameOrigin(url)) return; // no opaque cross-origin entries

  ev.respondWith(
    fetch(req)
      .then((res) => {
        // A response worth remembering: ok, same-origin, and not a no-store answer.
        if (res.ok && url.protocol.startsWith('http')) {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
      )
  );
});
