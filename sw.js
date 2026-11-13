const V = "v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || r.mode !== "navigate") return;
  e.respondWith(
    fetch(r).then((res) => { const c = res.clone(); caches.open(V).then((ch) => ch.put("./", c)); return res; })
      .catch(() => caches.match("./").then((m) => m || new Response("Offline", { status: 503 })))
  );
});
