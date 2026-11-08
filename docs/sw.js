/* PropScout service worker: offline shell + last-known data.
   Everything is network-first now. The shell used to be cache-first under a fixed
   cache name, so a returning visit (or the installed home-screen app) kept serving
   the app.js it cached days ago and never saw a deploy. Network-first means an
   online visit always gets the current shell, and the cache is only a fallback for
   offline / bad connections. Bump CACHE to force every client to refresh its shell. */
const CACHE = 'propscout-v2';
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
