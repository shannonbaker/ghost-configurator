const CACHE = "ghost-configurator-poc-v132";
const ASSETS = ["./", "./index.html", "./styles.css?v=61", "./app.js?v=101", "./mission-editor.js?v=5", "./profile.js", "./layout.js", "./serial.js", "./protocol.js", "./ghost-api.js", "./ghost-dp-api.js?v=2", "./field-colour.js", "./vrx-api.js", "./widgets/default.ini", "./ghost-logo.png", "./icon-192.png", "./icon-512.png", "./manifest.webmanifest"];
self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => event.respondWith(
  fetch(event.request).then((response) => {
    if (event.request.method === "GET" && response.ok &&
        new URL(event.request.url).origin === self.location.origin) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
    }
    return response;
  }).catch(() => caches.match(event.request)),
));
