// Keeps the remote working without internet once it has been opened: the page and its files are
// served from the phone's cache, refreshed in the background when there is a connection.
const CACHE = 'stagio-bt-remote-v2';
const FILES = ['./', 'index.html', 'remote.js', 'remote.css', 'manifest.webmanifest', '../icons/favicon.png', '../icons/apple-touch-icon.png', '../icons/icon-192.png', '../icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => {
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
