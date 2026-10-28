// Build replaces these values with an integrity-checked, versioned app shell.
const BUILD='development';
const ASSETS=[];
const PREFIX='suhjae-offline:'+self.registration.scope+':';
const CACHE=PREFIX+BUILD;
const urls=new Map(ASSETS.map(asset=>[new URL(asset.url,self.registration.scope).href,asset]));
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const responses=await Promise.all(ASSETS.map(async asset=>{
  const request=new Request(new URL(asset.url,self.registration.scope),{cache:'reload'}),response=await fetch(request);
  if(!response.ok)throw Error('Offline asset unavailable: '+asset.url);
  const digest=await crypto.subtle.digest('SHA-256',await response.clone().arrayBuffer());
  const hash=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==asset.sha256)throw Error('Offline asset version mismatch: '+asset.url);
  return [request,response];
 }));
 const cache=await caches.open(CACHE);
 try{await Promise.all(responses.map(([request,response])=>cache.put(request,response)));}catch(error){await caches.delete(CACHE);throw error;}
 // Updated workers wait for existing tabs to close, avoiding mixed SDK/WASM builds.
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET')return;
 const url=new URL(event.request.url);url.search='';url.hash='';
 if(!urls.has(url.href))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE),cached=await cache.match(url.href);
  if(cached)return cached;
  return fetch(event.request);
 })());
});
