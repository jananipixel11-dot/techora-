const CACHE_NAME = "techora-global-v3";
const TILE_CACHE = "techora-tiles"; // kept across versions so saved offline maps survive updates

const APP_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const file of APP_FILES) {
        try { await cache.add(file); } catch (e) { console.log("Could not cache:", file); }
      }
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys.filter((k) => k.startsWith("techora-global-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })
  );
});

const put = (cacheName, req, res) => {
  if (res.ok || res.type === "opaque") {
    const copy = res.clone();
    caches.open(cacheName).then((c) => c.put(req, copy));
  }
  return res;
};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // POSTs (SOS etc.) are queued by the app itself

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Page navigation: network first, fall back to the saved app shell
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => { if (res.ok) put(CACHE_NAME, "./index.html", res); return res; })
        .catch(async () =>
          (await caches.match("./index.html")) ||
          new Response("TECHORA is offline. Open the app once while connected.", {
            status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
          })
        )
    );
    return;
  }

  // Map tiles: cache first (saved offline maps), then network
  if (url.hostname === "tile.openstreetmap.org") {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return cached;
        try { return put(TILE_CACHE, request, await fetch(request)); }
        catch (e) { return new Response("", { status: 503 }); }
      })
    );
    return;
  }

  // App files and libraries: cache first
  if (url.origin === self.location.origin && !url.pathname.startsWith("/api/") || url.hostname.includes("unpkg.com")) {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return cached;
        try { return put(CACHE_NAME, request, await fetch(request)); }
        catch (e) { return new Response("", { status: 503 }); }
      })
    );
    return;
  }

  // Live data (weather, earthquakes, /api/helplines): network first, then last saved copy
  event.respondWith(
    fetch(request)
      .then((res) => put(CACHE_NAME, request, res))
      .catch(async () =>
        (await caches.match(request)) ||
        new Response(JSON.stringify({ offline: true, message: "No saved data. Connect to refresh." }), {
          status: 503, headers: { "Content-Type": "application/json" }
        })
      )
  );
});
