const CACHE_NAME = 'daily-schedule-v14';
const APP_FILES = [
  './',
  './index.html',
  './university.html',
  './training.html',
  './glass.css',
  './state.js',
  './storage.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('daily-schedule-') && key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin || url.pathname.startsWith('/api/') || url.pathname==='/login') return;
  if(event.request.mode === 'navigate' || event.request.destination === 'document'){
    event.respondWith(
      fetch(event.request).then(response => {
        const copy = response.clone();
        if(response.ok && !response.headers.get('Cache-Control')?.includes('no-store')) caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match(event.request,{ignoreSearch:true}).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const copy = response.clone();
      if(response.ok && !response.headers.get('Cache-Control')?.includes('no-store')) caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }))
  );
});
