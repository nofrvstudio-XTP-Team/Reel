// Cache ONLY app shell; no MP4 or JSON media is cached by Service Worker.
const CACHE='xtp-jp-v13-shell-1';
const SHELL=['./','./index.html','./app.css','./app.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  const shellPaths = SHELL.map(path=>new URL(path,self.registration.scope).pathname);
  if(url.origin!==location.origin || !shellPaths.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(res=>{
    if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));}
    return res;
  }).catch(()=>caches.match(event.request)));
});
