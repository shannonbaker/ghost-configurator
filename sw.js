const CACHE = "ghost-configurator-poc-v2";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./serial.js", "./protocol.js", "./ghost-api.js", "./icon.svg", "./manifest.webmanifest"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request).catch(() => caches.match(event.request))));
