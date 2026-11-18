// Offline copy of everything the editor has loaded once. Its own files come from the network while it answers,
// so a new deploy is never mixed with cached modules; CDN files carry their version in the URL, so a cached copy is right.
const CACHE = 'rlme';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const { request } = e;
  const own = new URL(request.url).origin === location.origin;
  if (request.method !== 'GET' || !own && !request.url.startsWith('https://cdn.jsdelivr.net/')) return;   // analytics and the like: not kept
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(request);
    if (hit && !own) return hit;
    try {
      const res = await fetch(request);
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      throw err;
    }
  }));
});
