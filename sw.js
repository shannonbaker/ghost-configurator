const CACHE = "ghost-configurator-poc-v58";
const ASSETS = ["./", "./index.html", "./styles.css?v=37", "./app.js?v=49", "./profile.js", "./layout.js", "./serial.js", "./protocol.js", "./ghost-api.js", "./ghost-dp-api.js", "./vrx-api.js", "./widgets/default.ini", "./widgets/catalog.json", "./widgets/manifests/compass.widget.ini", "./widgets/manifests/rotating_logo.widget.ini", "./widgets/manifests/link_status.widget.ini", "./widgets/manifests/vrx_status_bar.widget.ini", "./widgets/manifests/head_tracking.widget.ini", "./widgets/manifests/antenna_tracker.widget.ini", "./widgets/manifests/pid_scope.widget.ini", "./widgets/manifests/ghost_dp_stats.widget.ini", "./icon.svg", "./manifest.webmanifest"];
self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request).catch(() => caches.match(event.request))));
