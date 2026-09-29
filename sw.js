const CACHE = 'modo-rezar-v9';

const ARCHIVOS_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './liturgia.js',
  './voz-comun.js',
  './reproductor.js',
  './voz-previa.js',
  './voz-fish.js',
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
  // Al cambiar de versión se borran las cachés viejas — incluidas las
  // respuestas "no encontrado" que guardaba la versión anterior.
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

  // El audio y los días preparados (carpeta dias/) NO pasan por esta
  // caché. Antes sí, y guardaba hasta los "no encontrado": si alguien
  // abría la app antes de que el día estuviera listo, la app seguía
  // creyendo que no había audio para ese día aunque ya existiera, y lo
  // leía con la voz robótica del sistema. Ahora esos archivos van
  // siempre a la red (con la caché normal del navegador).
  if (url.pathname.indexOf('/dias/') !== -1) {
    return;
  }

  // Shell de la app: caché primero, con respaldo de red. Solo se guardan
  // respuestas completas y correctas (nunca un 404 ni un pedazo de audio).
  evento.respondWith(
    caches.match(evento.request).then((cacheada) => {
      return (
        cacheada ||
        fetch(evento.request).then((respuesta) => {
          if (respuesta && respuesta.status === 200 && respuesta.type === 'basic') {
            const copia = respuesta.clone();
            caches.open(CACHE).then((cache) => cache.put(evento.request, copia)).catch(() => {});
          }
          return respuesta;
        })
      );
    })
  );
});
