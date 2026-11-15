// שני תפקידים: (1) האפליקציה נפתחת גם בלי קליטה, (2) הדף מקבל "בידוד" שמאפשר למנוע התמלול לעבוד על כמה ליבות.
const SHELL = 'kt-shell-v1';
const STATIC = 'kt-static-v1'; // ספריות, פונטים ומנוע התמלול: כבדים ולא משתנים
const IS_STATIC = /\/(vendor|fonts|models)\//;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key !== SHELL && key !== STATIC) await caches.delete(key);
  await self.clients.claim();
})()));

function isolate(res) {
  if (!res || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function fromStatic(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200) cache.put(req, res.clone());
  return res;
}

async function fromShell(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await (req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' }));
    if (res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await cache.match('./')));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  event.respondWith((IS_STATIC.test(url.pathname) ? fromStatic(req) : fromShell(req)).then(isolate));
});
