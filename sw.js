/* 微影 V-ing Service Worker — app shell 预缓存 + stale-while-revalidate */
var CACHE = 'ving-v20261017';
var APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/lib/html2canvas.min.js',
  './assets/logo.svg',
  './assets/favicon.svg',
  './manifest.json'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c){ return c.addAll(APP_SHELL); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);
  /* 跨域请求（Google Fonts / jsdelivr CDN）交给浏览器处理，避免 CORS 缓存问题 */
  if(url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function(cached){
      var network = fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy); });
        return res;
      }).catch(function(){ return cached; });
      return cached || network;
    })
  );
});
