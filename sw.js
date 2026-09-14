const CACHE = 'modo-rezar-v1';

const ARCHIVOS_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './audios/benedictus.mp3',
  './audios/invitatorio-salmo-94.mp3'
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARCHIVOS_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((claves) =>
      Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);

  // El texto de la liturgia cambia cada día: siempre ir a la red.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Shell de la app: cache primero, con respaldo de red.
  evento.respondWith(
    caches.match(evento.request).then((cacheada) => {
      return (
        cacheada ||
        fetch(evento.request).then((respuesta) => {
          const copia = respuesta.clone();
          caches.open(CACHE).then((cache) => cache.put(evento.request, copia));
          return respuesta;
        })
      );
    })
  );
});
