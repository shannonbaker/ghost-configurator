const CACHE = "ghost-configurator-poc-v99";
const ASSETS = ["./", "./index.html", "./styles.css?v=43", "./app.js?v=74", "./profile.js", "./layout.js", "./serial.js", "./protocol.js", "./ghost-api.js", "./ghost-dp-api.js", "./field-colour.js", "./vrx-api.js", "./widgets/default.ini", "./widgets/manifests/status.widget.ini", "./widgets/manifests/sticks.widget.ini", "./widgets/manifests/ahi.widget.ini", "./widgets/catalog.json", "./widgets/manifests/rc_menu.widget.ini", "./widgets/manifests/battery.widget.ini", "./widgets/manifests/compass.widget.ini", "./widgets/manifests/rotating_logo.widget.ini", "./widgets/manifests/link_status.widget.ini", "./widgets/manifests/vrx_status_bar.widget.ini", "./widgets/manifests/head_tracking.widget.ini", "./widgets/manifests/mini_map.widget.ini", "./widgets/manifests/antenna_tracker.widget.ini", "./widgets/manifests/pid_scope.widget.ini", "./widgets/manifests/ghost_dp_stats.widget.ini", "./widgets/manifests/msp_dp_osd.widget.ini", "./widgets/manifests/vtx_temperature.widget.ini", "./icon.svg", "./manifest.webmanifest"];
self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request).catch(() => caches.match(event.request))));
