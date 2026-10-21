// Cache-first, revalidate in the background.
//
// This was network-first, which meant the app could not paint a single byte
// until the network answered. A phone waking from the app switcher often has a
// radio that makes requests HANG rather than fail, and a hanging fetch inside
// respondWith blocks the page itself — so every cold launch stalled until a
// manual refresh, by which time the radio was up. The .catch() fallback never
// helped: it only runs when fetch fails, not when it hangs.
//
// Serving the cache first makes startup independent of the network. The fetch
// still runs, refreshes the cache, and tells the page when a deploy has landed,
// which is what network-first was protecting (a deploy must never be invisible).
const CACHE = "caltrack-v14";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./math.js", "./db.js", "./cloud.js", "./llm.js", "./manifest.webmanifest", "./icon.svg", "./seed/foods.json"];
const NET_TIMEOUT = 8000;

self.addEventListener("install", (e) => {
  // addAll() also reads through the HTTP cache, so without cache:"reload" the
  // offline copy can be primed with the very files a deploy just replaced.
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

let announced = false;

async function tellClients(msg) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const c of clients) c.postMessage(msg);
}

// Refresh the cached copy and report whether this URL changed. Never throws:
// a failed or slow revalidation must not affect what the page was served.
async function revalidate(req, cache, cached) {
  let res;
  try {
    res = await Promise.race([
      fetch(req, { cache: "no-cache" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), NET_TIMEOUT)),
    ]);
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;
  const tag = (r) => (r && (r.headers.get("etag") || r.headers.get("last-modified"))) || "";
  const changed = !!cached && !!tag(res) && !!tag(cached) && tag(res) !== tag(cached);
  try { await cache.put(req, res.clone()); } catch { /* quota, nothing to do */ }
  if (changed && !announced) {
    announced = true;
    tellClients({ type: "update-ready" });
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // never touch API calls
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = revalidate(e.request, cache, cached);
    e.waitUntil(fresh);
    // The cached copy wins the race unconditionally: startup must not depend on
    // the radio. The page learns about a new version through update-ready.
    if (cached) return cached;
    const res = await fresh;
    return res || new Response("Offline and not cached yet.", { status: 503, headers: { "content-type": "text/plain" } });
  })());
});
