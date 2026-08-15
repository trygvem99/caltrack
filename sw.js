// Network-first with cache fallback: offline works, and new deploys are picked
// up automatically without a cache-name bump per deploy.
const CACHE = "caltrack-v2";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./math.js", "./db.js", "./llm.js", "./manifest.webmanifest", "./icon.svg", "./seed/foods.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // never touch API calls
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
