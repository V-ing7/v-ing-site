/**
 * Service Worker — 微影 V-ing PWA
 * 仅缓存静态资源，API 调用和网络请求直连
 */
const CACHE_NAME = 'ving-pwa-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.html',
  '/manifest.webmanifest',
  '/assets/logo.svg',
  '/assets/favicon.svg',
  '/assets/pwa-icon.svg',
  '/assets/pwa-icon-maskable.svg',
  '/css/style.css',
  '/js/app.js',
  '/js/lib/html2canvas.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 跳过 SSE / API / 跨域请求
  if (url.pathname.startsWith('/api/') || event.request.url.includes('/api/v-ing-stream')) {
    return;
  }
  if (url.origin !== self.location.origin) {
    return;
  }
  // SSE 用 navigator，不经过 fetch 事件，但保险起见跳过
  if (event.request.headers.get('accept')?.includes('text/event-stream')) {
    return;
  }

  // 网络优先，失败回退缓存（适用所有静态资源）
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/app.html')))
  );
});
