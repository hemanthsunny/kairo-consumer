// Kairo Link service worker: lets the app be installed and opens a cached shell when offline.
// Only page loads are handled; API calls, auth and calendar data always go to the network.
const CACHE = "kl-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add("/")).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.mode !== "navigate" || new URL(req.url).pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put("/", res.clone()));
        return res;
      })
      .catch(() => caches.match("/").then((r) => r || Response.error())),
  );
});
