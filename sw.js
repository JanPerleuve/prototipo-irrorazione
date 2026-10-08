// Service worker della web app (generato da tools/genera_webapp.py: non modificare in webapp/).
// Tiene in cache tutti i file dell'app, così si apre anche senza rete in vigneto.
// File dell'app: prima la rete (così dopo una pubblicazione si vede subito la versione nuova), e la copia
// in cache se la rete manca o non risponde entro NET_TIMEOUT. Font di Google: cache dopo il primo uso.
const CACHE = 'irrorazione-fb1d0d266464';
const FILES = ["./", "Elaborazione.dc.html", "Login.dc.html", "Main.dc.html", "Rilievi.dc.html", "Risultati.dc.html", "Scelta.dc.html", "Schede.dc.html", "Semplice.dc.html", "Taratura.dc.html", "analisi.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "index.html", "jsQR.js", "manifest.webmanifest", "qrcode.js", "schede.js", "support.js"];
const NET_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('irrorazione-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function fromNetwork(req, key, cache) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT);
    fetch(req, { cache: 'no-cache' }).then((res) => {
      clearTimeout(timer);
      if (!res || !res.ok) { reject(new Error('http')); return; }
      cache.put(key, res.clone());
      resolve(res);
    }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (fonts) {
    e.respondWith(caches.open(CACHE).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // "Semplice.dc.html?rilievo=RS-0001" è la stessa pagina: in cache senza la parte dopo il "?"
  const key = url.origin + url.pathname;
  e.respondWith(caches.open(CACHE).then((cache) =>
    fromNetwork(req, key, cache).catch(() => cache.match(key).then((hit) => hit || cache.match(req, { ignoreSearch: true }))
      .then((hit) => hit || Response.error()))));
});
