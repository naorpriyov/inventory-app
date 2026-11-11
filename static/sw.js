/* מאפשר התקנה כאפליקציה ופתיחה מהירה. הנתונים תמיד נטענים מהשרת. */
const CACHE='inv-shell-v1';
const SHELL=['/static/shim.js','/static/auth.html','/manifest.webmanifest','/static/icons/icon-192.png','/static/icons/icon-512.png'];
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname==='/logout') return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(r=>{ if(r.ok&&u.pathname==='/'){ const c=r.clone(); caches.open(CACHE).then(x=>x.put('/',c)); } return r; })
      .catch(()=>caches.match('/').then(r=>r||caches.match('/static/auth.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{ if(res.ok&&u.pathname.startsWith('/static/')){ const c=res.clone(); caches.open(CACHE).then(x=>x.put(e.request,c)); } return res; })));
});
