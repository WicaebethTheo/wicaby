/// <reference lib="webworker" />
// The service worker: the app shell, precached, so the app opens at once and offline; nothing else.
// It answers only this origin's own files. Server requests (API, images, streams) are never seen or stored here:
// they carry the account's token, and the server's own cache headers already serve its images.
// A module, so this `self` (the worker's own scope) shadows the lib's generic one.
export type {};
declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __SW_VERSION__: string;

const SHELL = `wicaby-shell-${__SW_VERSION__}`;
const scope = new URL(self.registration.scope);
const INDEX = new URL('index.html', scope).href;
const PRECACHE = new Set(__PRECACHE__.map((f) => new URL(f, scope).href));

self.addEventListener('install', (event) => {
  // `cache: 'reload'` skips the HTTP cache: a stale file from the previous version must never enter the new shell.
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll([...PRECACHE].map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('wicaby-shell-') && key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page asks for the waiting worker to take over once the user accepts the update (lib/updates.svelte.ts).
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin) return;
  // Any navigation inside the scope is the single-page app.
  if (req.mode === 'navigate' && url.href.startsWith(scope.href)) {
    event.respondWith(caches.match(INDEX, { cacheName: SHELL }).then((hit) => hit ?? fetch(req)));
    return;
  }
  url.search = '';
  if (!PRECACHE.has(url.href)) return;
  event.respondWith(caches.match(url.href, { cacheName: SHELL }).then((hit) => hit ?? fetch(req)));
});
