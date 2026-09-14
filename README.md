# Modo Rezar — Liturgia de las Horas

App web (PWA) que lee en voz alta la Liturgia de las Horas del día,
deteniéndose donde te toca responder a ti, igual que hacía el prototipo
de Tampermonkey — pero como sitio propio, no como extensión, y funciona
igual en el celular que en el computador.

## Cómo funciona (arquitectura)

- `liturgiadelashoras.github.io` es un sitio estático: cada hora litúrgica
  vive en un archivo `.htm` fijo, por ejemplo
  `sync/2026/sep/09/laudes.htm`.
- Esta app lee ese mismo archivo directamente desde el repositorio en
  GitHub (`raw.githubusercontent.com`), que **sí envía cabeceras CORS**
  (`access-control-allow-origin: *`), así que el navegador puede leerlo
  sin proxy ni servidor propio.
- La fuente marca las rúbricas (`V.`, `R.`, `Ant.`, títulos de sección)
  en rojo (`<FONT COLOR="#FF0000">`) y el texto que se reza en negro.
  `app.js` reconstruye esas líneas y las clasifica: título, voz guía,
  respuesta del usuario, antífona o lectura — sin depender de heurísticas
  de mayúsculas como el prototipo anterior.
- No se copia ni un solo texto litúrgico a mano: todo sale siempre de la
  fuente original, al vuelo.

## Cómo probarla ya mismo

Necesita servirse por http(s) (no abrir el `index.html` con doble clic),
porque el service worker y el `fetch` no funcionan con `file://`.

Opción rápida en tu computador:

```bash
cd modo-rezar
python3 -m http.server 8080
```

y abre `http://localhost:8080` en el navegador.

## Cómo publicarla para usarla desde el celular también

Cualquier hosting de archivos estáticos sirve, por ejemplo GitHub Pages,
Netlify o Vercel (gratis):

1. Sube esta carpeta tal cual a un repositorio de GitHub.
2. Activa GitHub Pages para ese repositorio (Settings → Pages → rama
   `main`, carpeta raíz).
3. Entra a la URL que te da GitHub Pages desde el celular y el PC.
4. En el celular (Chrome/Safari) usa "Añadir a pantalla de inicio"; en
   el PC (Chrome/Edge) aparecerá un botón "Instalar app" — la app
   detecta esto sola y te lo ofrece dentro de la propia pantalla de
   inicio.

Una vez instalada se abre como cualquier app, con su propio ícono, sin
barra de navegador — que es justo lo que no lograba una extensión.

## Audio propio para salmos, cánticos e himnos

Cuando el paso es un salmo, cántico o himno, si no tienes audio asignado
verás un enlace "🎵 Lo tengo en formato canción — asignar audio": elige
el archivo (mp3, m4a, etc.) desde tu celular o PC y se guarda en el
dispositivo (IndexedDB, nunca sube a ningún servidor). Desde ese momento
esa pieza se reproduce con tu grabación en vez de leerse con voz
sintética.

El salterio de la Liturgia de las Horas rota cada 4 semanas, así que el
mismo salmo (mismo título exacto) vuelve a aparecer más adelante — la
app lo reconoce solo por el título y reutiliza el audio que ya
asignaste, sin que tengas que volver a subirlo. Como el audio se guarda
por dispositivo, tendrás que asignarlo una vez en el celular y una vez
en el PC si usas ambos.

Puedes cambiar o quitar el audio asignado desde los enlaces que
aparecen debajo del reproductor, en cualquier momento.

## Reconocimiento de voz (manos libres)

En "Responde tú" y al repetir la antífona, la app puede escuchar el
micrófono y avanzar sola cuando detecta que ya dijiste el texto — se
activa con el interruptor "Reconocer cuando yo hablo" en los ajustes
(⚙ arriba a la derecha durante la oración).

Límites importantes, para que no te sorprenda:
- **Safari en iPhone/iPad no soporta esto todavía** (no es un bug de la
  app, es que Apple no implementa esa función del navegador). Ahí solo
  queda el botón manual, que siempre funciona igual.
- En Chrome/Edge (Android y PC) sí funciona, pero pedirá permiso de
  micrófono la primera vez.
- El botón manual nunca desaparece: el reconocimiento es una ayuda
  extra, no un reemplazo — si no te reconoce bien, simplemente tocas
  "Ya respondí" / "Ya la repetí" como antes.

## Qué quedó pendiente

- **Offline real de días futuros**: hoy el service worker cachea la
  app, no el texto del día (que cambia a diario). Se podría precachear
  el día siguiente cuando hay conexión.
- **Compartir tus audios entre celular y PC** sin volver a subirlos:
  requeriría guardarlos en algún lado en la nube (por ejemplo, tu propio
  Google Drive) en vez de solo en el dispositivo.
