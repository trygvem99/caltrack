// Network-first with cache fallback: offline works, and new deploys are picked
// up automatically without a cache-name bump per deploy.
const CACHE = "caltrack-v6";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./math.js", "./db.js", "./cloud.js", "./llm.js", "./manifest.webmanifest", "./icon.svg", "./seed/foods.json"];

self.addEventListener("install", (e) => {
  // addAll() also reads through the HTTP cache, so without cache:"reload" the
  // offline fallback can be primed with the very files a deploy just replaced.
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))
    )
  );
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // never touch API calls
  // `cache: "no-cache"` makes this genuinely network-first. A plain fetch() goes
  // through the browser HTTP cache, and GitHub Pages sends max-age=600 — so a
  // deploy stayed invisible for ten minutes and the stale copy got re-cached
  // here on top. "no-cache" still revalidates (304 when unchanged), so it costs
  // almost nothing but always sees a new deploy immediately.
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
