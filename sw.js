const CACHE = "ghost-configurator-poc-v48";
const ASSETS = ["./", "./index.html", "./styles.css?v=35", "./app.js?v=37", "./profile.js", "./layout.js", "./serial.js", "./protocol.js", "./ghost-api.js", "./widgets/default.ini", "./widgets/catalog.json", "./widgets/manifests/compass.widget.ini", "./widgets/manifests/rotating_logo.widget.ini", "./widgets/manifests/link_status.widget.ini", "./widgets/manifests/vrx_status_bar.widget.ini", "./widgets/manifests/head_tracking.widget.ini", "./widgets/manifests/antenna_tracker.widget.ini", "./icon.svg", "./manifest.webmanifest"];
self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request).catch(() => caches.match(event.request))));
