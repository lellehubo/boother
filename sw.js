// Passfotoautomaten — enkel app-shell-cache så gränssnittet startar offline.
// Proxyanropen (Supabase/Gemini) rörs aldrig; bara samma-origin-GET cachas.
// Bumpa CACHE vid varje ändring av de cachade filerna så gamla versioner rensas.
const CACHE = "passfoto-v3";
const ASSETS = [
  ".",
  "index.html",
  "manifest.json",
  "icon.svg",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POST till proxyn lämnas orörd
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // bara app-shell, ej Supabase/Gemini

  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match("index.html"))
    )
  );
});
