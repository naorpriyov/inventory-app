/* מאפשר התקנה כאפליקציה ופתיחה מהירה. הנתונים תמיד נטענים מהשרת.
   קבצי התוכנה נטענים קודם מהשרת (כדי שעדכונים יגיעו מיד), והעותק השמור משמש רק כשאין חיבור. */
const CACHE='inv-shell-v2';
const SHELL=['/static/shim.js','/static/auth.html','/manifest.webmanifest','/static/icons/icon-192.png','/static/icons/icon-512.png'];
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname==='/logout') return;
  const key=e.request.mode==='navigate'?(u.pathname==='/'?'/':null):e.request;
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok&&key&&(e.request.mode==='navigate'||u.pathname.startsWith('/static/')||u.pathname==='/manifest.webmanifest')){ const c=r.clone(); caches.open(CACHE).then(x=>x.put(key,c)); }
    return r;
  }).catch(()=>caches.match(e.request.mode==='navigate'?(u.pathname==='/'?'/':'/static/auth.html'):e.request).then(r=>r||caches.match('/static/auth.html'))));
});
