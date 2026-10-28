// Build replaces these values with an integrity-checked, versioned app shell.
const BUILD="6a7e9dc3eb52f97ef84d";
const ASSETS=[{"url":"./","sha256":"ef2026eee59cb5a445e7545ae14ac9519d3781cba93dc2695ccc4be54c67a89a"},{"url":"./index.html","sha256":"ef2026eee59cb5a445e7545ae14ac9519d3781cba93dc2695ccc4be54c67a89a"},{"url":"./app.css","sha256":"83eec686f7e183c6ff0904bfb171e7681debef26e079e577dd131b232bb9a4cc"},{"url":"./app.js","sha256":"1c6acdaa0151bd2a3c816f93a1694ba6fa3b1662dc2c332baf1da2665cb0edfd"},{"url":"./store.js","sha256":"23b9343e5ceece2bd3f60e03aee9c68d3c879f5ded8b2dceaa957bd8a2668d0e"},{"url":"./browser-sync.js","sha256":"dc89068075af9472aa3a949a86093260360b730ec814c0c9bb8e5c7254366037"},{"url":"./offline.js","sha256":"cea48f1fcf43e3439a376001c65aa4275bbade040d12db320018da68730a808c"},{"url":"./export-zip.js","sha256":"0213385278aa33cbaa1f468156a720f46f4932488e0a68f0899d2e2903d4e3b0"},{"url":"../../vendor/sohjae/editor.js","sha256":"2e3a1a7f0aa839020d66c72bc65a08079d03ab4eeccec76a4e90c5fa3a7346c5"},{"url":"../../vendor/sohjae/editor.css","sha256":"46101cf1e59465a0a9578dc62ec9765776bda51364d7e7a35f41b27394f69a74"},{"url":"../../vendor/sohjae/core.js","sha256":"207074c8cab356fe4f427478af73b3c8fe8f978a36dc82ac90b2704ff6977e7e"},{"url":"../../vendor/sohjae/clipboard.js","sha256":"fef7ddc1a633d18420577da048b7f2c682378588ce70e58186e984bac548fb0f"},{"url":"../../vendor/sohjae/html.js","sha256":"a6f30de48d158ecd00fc2b1cb76cc5de0f1c4ffa1fe65f1ab6172618c03b8efc"},{"url":"../../vendor/sohjae/rich-dom.js","sha256":"cec98cfd452e8b6efad44838bf8f3deadd90c0f119e89030f50fd948d9dac776"},{"url":"../../vendor/sohjae/source-map.js","sha256":"5a3e223657760edbb202c2a524688261ed84907dd0f504d7fd54492b1449dc6d"},{"url":"../../vendor/sohjae/renderer.js","sha256":"d98161ac85fcfdc832f02766bca692428053cdcc605c65b7d73136f06f0d57b9"},{"url":"../../vendor/sohjae/renderer.css","sha256":"f9c3dad1ebf78d1f4fa1303d695f5ceeaf3d4f8afa29ea801fced87bbe23e284"},{"url":"../../vendor/sohjae/collab/core.js","sha256":"f1ae93b8210f32d527ed041cbc1e9ee5a612734a6efb725a7cb443263714a9b8"},{"url":"../../vendor/sohjae/collab/editor_core.js","sha256":"a39ab4d92b227f0975dfa3dc6dbda06bc51343d422b43e9bda2570ac4e2bb6c7"},{"url":"../../vendor/sohjae/sohjae_editor.wasm","sha256":"383e12053efc87b32a41e1dd79c2b874139070d1b873a2c1386ad829ca0e7f62"},{"url":"../../vendor/sohjae/sohjae_collaborator.wasm","sha256":"c1fef9bcf0aeb45390d28f40dd701d3220f42f6620a866c034bbe5ac38636d71"},{"url":"../../vendor/sohjae/sohjae_render.wasm","sha256":"2f2db1517baacb0525d513f6363b47624fa514d48d6e82e707e2dae0c3b9863e"}];
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
