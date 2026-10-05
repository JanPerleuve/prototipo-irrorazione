// Service worker della web app (generato da tools/genera_webapp.py: non modificare in webapp/).
// Tiene in cache tutti i file dell'app, così si apre anche senza rete in vigneto.
// I file dell'app: prima la cache, poi la rete aggiorna la copia. I font di Google: cache dopo il primo uso.
const CACHE = 'irrorazione-2e474bd3ff5b';
const FILES = ["./", "Elaborazione.dc.html", "Login.dc.html", "Main.dc.html", "Rilievi.dc.html", "Risultati.dc.html", "Scelta.dc.html", "Semplice.dc.html", "Taratura.dc.html", "analisi.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "index.html", "manifest.webmanifest", "support.js"];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('irrorazione-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !fonts) return;
  e.respondWith(caches.open(CACHE).then((cache) =>
    // ignoreSearch: "Semplice.dc.html?rilievo=RS-0001" è la stessa pagina
    cache.match(req, { ignoreSearch: url.origin === self.location.origin }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })));
});
