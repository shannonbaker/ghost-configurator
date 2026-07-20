const CACHE = "ghost-configurator-poc-v28";
const ASSETS = ["./", "./index.html", "./styles.css?v=28", "./app.js?v=28", "./layout.js", "./serial.js", "./protocol.js", "./ghost-api.js", "./widgets/default.ini", "./widgets/catalog.json", "./widgets/manifests/rotating_logo.widget.ini", "./widgets/manifests/link_status.widget.ini", "./icon.svg", "./manifest.webmanifest"];
self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request).catch(() => caches.match(event.request))));
