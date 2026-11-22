const CACHE='fastq-pos-app-v37';
const CORE=['./','./index.html','./manifest.webmanifest','./icon.svg','./favicon.ico','./fastq-mark.png','./fastq-icon-192.png','./fastq-icon-512.png','./fastq-cart.png','./polish-landing.css','./polish-dashboard.css','./polish-gemini-shell.css','./polish-gemini2-fonts.css','./polish-gemini2-shell.css','./pos-utils.mjs','./pos-storage.mjs','./report-utils.mjs','./attendance-utils.mjs','./shift-utils.mjs','./cart-utils.mjs','./sync-policy.js','./sync-role-policy.mjs','./legacy/index.html','./legacy/account.js','./legacy/pos.js','./legacy/pos-utils.mjs','./legacy/pos-storage.mjs','./legacy/report-utils.mjs','./legacy/attendance-utils.mjs','./legacy/shift-utils.mjs','./legacy/cart-utils.mjs','./legacy/sync-policy.js','./legacy/sync-role-policy.mjs','./legacy/polish.css','./legacy/polish-extra.css','./legacy/polish-kasir.css','./legacy/polish-logo.css','./legacy/polish-laporan.css','./legacy/polish-produk.css','./legacy/polish-shift.css','./legacy/polish-pengguna.css','./legacy/polish-gemini-kasir.css','./legacy/polish-gemini-laporan.css','./legacy/polish-gemini-produk.css','./legacy/polish-gemini-shift.css','./legacy/polish-gemini-pengguna.css','./legacy/polish-gemini2-cart.css','./legacy/polish-gemini2-fonts.css','./legacy/polish-gemini2-pages.css','./legacy/polish-gemini2-icons.css','./legacy/polish-gemini3-chrome.css','./legacy/polish-gemini3-ops.css','./legacy/polish-gemini3-produk.css','./legacy/polish-gemini3-laporan.css','./legacy/polish-gemini3-kasir.css','./legacy/fastq-cart.png','./assets/fonts/inter-400.woff2','./assets/fonts/inter-500.woff2','./assets/fonts/inter-600.woff2','./assets/fonts/inter-700.woff2','./assets/fonts/plus-jakarta-sans-600.woff2','./assets/fonts/plus-jakarta-sans-700.woff2','./assets/fonts/plus-jakarta-sans-800.woff2'];
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(CORE.map(path=>new Request(path,{cache:'reload'})));
  const shell=await cache.match('./index.html');
  const html=shell?await shell.text():'';
  const assets=[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match=>match[1]);
  await Promise.all(assets.map(async path=>{try{await cache.add(path)}catch{}}));
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>(key.startsWith('titik-kasir-')||key.startsWith('fastq-pos-'))&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if (/\.(?:js|mjs|css)$/.test(url.pathname) && !url.pathname.includes('/assets/')) {
    event.respondWith(fetch(new Request(request,{cache:'no-cache'})).then(async response=>{
      if(response.ok){const cache=await caches.open(CACHE);await cache.put(request,response.clone());}
      return response;
    }).catch(async()=>{
      const cached=await caches.match(request);
      if(cached)return cached;
      return Response.error();
    }));
    return;
  }
  if(request.mode==='navigate'){
    const legacy = url.pathname.includes('/legacy/');
    event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response}).catch(async()=>await caches.match(request)||await caches.match(legacy?'./legacy/index.html':'./index.html')));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response})));
});
