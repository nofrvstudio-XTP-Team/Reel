
/*
 XTP JP PWA Service Worker
 Network-first shell, automatic updates.
 MP4 remains hosted on Cloudflare R2.
*/

'use strict';

const CACHE = 'xtp-jp-shell-network-v1';

const SHELL = new Set([
 'index.html',
 'app.js',
 'app.css',
 'sw.js',
 'manifest.webmanifest',
 'icon.svg',
 'xtp-config.json'
]);

const ROOT = new URL(self.registration.scope);

function normalizedAsset(url) {
 if (
  url.origin !== ROOT.origin ||
  !url.pathname.startsWith(ROOT.pathname)
 ) {
  return null;
 }

 let name = url.pathname.slice(ROOT.pathname.length);

 if (name === '') {
  name = 'index.html';
 }

 if (!SHELL.has(name)) {
  return null;
 }

 return new Request(
  new URL(name, ROOT).toString()
 );
}

self.addEventListener('install', event => {
 event.waitUntil(
  self.skipWaiting()
 );
});

self.addEventListener('activate', event => {
 event.waitUntil((async () => {
  const keys = await caches.keys();

  await Promise.all(
   keys
    .filter(key =>
     (
      key.startsWith('xtp-jp-v13-shell') ||
      key.startsWith('xtp-jp-shell-')
     ) &&
     key !== CACHE
    )
    .map(key => caches.delete(key))
  );

  await self.clients.claim();
 })());
});

self.addEventListener('fetch', event => {
 if (event.request.method !== 'GET') {
  return;
 }

 const key = normalizedAsset(
  new URL(event.request.url)
 );

 if (!key) {
  return;
 }

 event.respondWith((async () => {
  try {
   const response = await fetch(
    event.request,
    {cache:'no-store'}
   );

   if (response.ok && response.type !== 'opaque') {
    const copy = response.clone();

    event.waitUntil(
     caches.open(CACHE)
      .then(cache => cache.put(key, copy))
      .catch(() => {})
    );
   }

   return response;

  } catch (error) {
   const cached = await caches.match(key);

   if (cached) {
    return cached;
   }

   throw error;
  }
 })());
});
