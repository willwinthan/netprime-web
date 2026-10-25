/* NetPrime service worker (registered by src/pwa/pwa.tsx as /sw.js?v=<build>).
 * - HTML navigations: network first, cached copy or /offline.html when offline.
 * - Static assets (hashed /assets/*, icons, fonts, images): cache first.
 * - Never touches /api or other origins (the API, Google Fonts CSS, video embeds): those go to the network.
 * - A new version waits until the page asks it to take over (SKIP_WAITING), see the "มีเวอร์ชันใหม่" banner.
 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `np-static-${VERSION}`;
const PAGE_CACHE = "np-pages-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

// Web Push handlers from the communication module, when deployed. The SPA fallback answers a missing
// file with HTML, which importScripts rejects; the worker then simply runs without push support.
try { importScripts("/push-handler.js"); } catch (error) { /* push-handler.js not deployed */ }

self.addEventListener("install", event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(PRECACHE)).catch(() => undefined));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("np-static-") && k !== STATIC_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const STATIC_PATH = /^\/(assets|icons)\/|\.(?:js|css|png|jpe?g|webp|gif|svg|ico|woff2?|webmanifest)$/;

async function networkFirst(request) {
  const cache = await caches.open(PAGE_CACHE);
  // Keyed by path only: query strings (reset/verification tokens) are never written to the cache.
  const key = new URL(request.url).pathname;
  try {
    const response = await fetch(request);
    if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) cache.put(key, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(key)) || (await cache.match("/")) || (await caches.match(OFFLINE_URL)) ||
      new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only real files: the SPA fallback returns index.html for unknown paths, which must not be cached as an asset.
  const type = response.headers.get("content-type") || "";
  if (response.ok && response.type === "basic" && !type.includes("text/html")) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/api" || url.pathname === "/sw.js" || url.pathname === "/push-handler.js") return;
  if (url.pathname === "/sitemap.xml" || url.pathname === "/robots.txt") return;
  if (request.mode === "navigate") { event.respondWith(networkFirst(request)); return; }
  if (STATIC_PATH.test(url.pathname)) event.respondWith(cacheFirst(request));
});
