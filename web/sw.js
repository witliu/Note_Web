// Cache the public shell only. API responses and personal records never enter Cache Storage.
const CACHE = 'journal-text-shell-v26';
const SHELL = ['/', '/app.js?v=20261108-10', '/styles.css?v=20261108-10', '/server.css?v=20261108-10', '/map.js?v=20261108-10', '/quizzes.js?v=20261108-10', '/media.js?v=20261108-10', '/quotes.js?v=20261108-10', '/map-data/china.json',
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
  const provinceMap = /^\/map-data\/provinces\/\d{6}\.json$/.test(url.pathname);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || (!SHELL.includes(url.pathname + url.search) && !provinceMap)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
