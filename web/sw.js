// Cache the public shell only. API responses and personal records never enter Cache Storage.
const CACHE = 'journal-text-shell-v5';
const SHELL = ['/', '/app.js', '/styles.css', '/server.css', '/map.js', '/quizzes.js', '/media.js', '/map-data/china.json',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/assets/mountain.jpg', '/assets/sea.jpg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('journal-text-shell-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
