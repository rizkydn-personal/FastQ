const CACHE = 'fastq-pos-app-v46';
const BUILD_ASSETS = [];
const CORE_ASSETS = [
  './',
  './index.html',
  './pos',
  './pos.html',
  './pos-runtime.js',
  './vendor/product-xlsx.js',
  './pos.css',
  './pos-fonts.css',
  './vendor/phosphor-duotone.css',
  './vendor/phosphor-bold.css',
  './vendor/phosphor-regular.css',
  './vendor/phosphor-fill.css',
  './vendor/fflate.js',
  './vendor/Phosphor-Duotone.woff2',
  './vendor/Phosphor-Bold.woff2',
  './vendor/Phosphor.woff2',
  './vendor/Phosphor-Fill.woff2',
  './manifest.webmanifest',
  './icon.svg',
  './favicon.ico',
  './fastq-mark.png',
  './fastq-icon-192.png',
  './fastq-icon-512.png',
  './fastq-cart.png',
  './landing.css',
  './shell-theme.css',
  './typography.css',
  './shell-layout.css',
  './pos-utils.mjs',
  './pos-storage.mjs',
  './cart-utils.mjs',
  './sale-policy.mjs',
  './shift-utils.mjs',
  './sync-policy.js',
  './sync-role-policy.mjs',
  './assets/fonts/inter.woff2',
  './assets/fonts/plus-jakarta-sans.woff2',
];

self.addEventListener('message', (event) => {
  if (event.data?.type === 'FASTQ_ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE_ASSETS.map((path) => new Request(path, { cache: 'reload' })));

      await Promise.allSettled(BUILD_ASSETS.map((assetPath) => cache.add(assetPath)));

      const appShell = await cache.match('./index.html');
      const shellHtml = appShell ? await appShell.text() : '';
      const referencedAssets = [...shellHtml.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
        (match) => match[1],
      );

      await Promise.all(
        referencedAssets.map(async (assetPath) => {
          try {
            await cache.add(assetPath);
          } catch {}
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheKeys) =>
        Promise.all(
          cacheKeys
            .filter(
              (cacheKey) =>
                (cacheKey.startsWith('titik-kasir-') || cacheKey.startsWith('fastq-pos-')) &&
                cacheKey !== CACHE,
            )
            .map((cacheKey) => caches.delete(cacheKey)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  if (
    request.method !== 'GET' ||
    requestUrl.origin !== self.location.origin ||
    requestUrl.pathname.startsWith('/api/')
  ) {
    return;
  }

  const isApplicationScript =
    /\.(?:js|mjs|css)$/.test(requestUrl.pathname) && !requestUrl.pathname.includes('/assets/');
  if (isApplicationScript) {
    event.respondWith(
      fetch(new Request(request, { cache: 'no-cache' }))
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(request, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request, { ignoreSearch: true });
          return cachedResponse || Response.error();
        }),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseToCache = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, responseToCache));
          }
          return response;
        })
        .catch(async () => {
          const cachedPage = await caches.match(request, { ignoreSearch: true });
          return cachedPage || caches.match('./index.html');
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(request).then((response) => {
        if (response.ok) {
          const responseToCache = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, responseToCache));
        }
        return response;
      });
    }),
  );
});
