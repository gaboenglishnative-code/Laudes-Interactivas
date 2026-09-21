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

La app usa **un solo reconocedor de voz para toda la sesión**, reutilizado
turno tras turno, en vez de crear uno nuevo cada vez — eso es lo que antes
hacía que algunos navegadores (Brave, Chrome) volvieran a pedir permiso de
micrófono una y otra vez. En ajustes hay un botón **"Activar micrófono
ahora"** para conceder el permiso una sola vez, de forma explícita, antes
de empezar a rezar — así no aparece de sorpresa a mitad de una antífona.

Límites importantes, para que no te sorprenda:
- **Safari en iPhone/iPad no soporta esto todavía** (no es un bug de la
  app, es que Apple no implementa esa función del navegador). Ahí solo
  queda el botón manual, que siempre funciona igual.
- El permiso de micrófono lo recuerda el navegador, no la app — una vez
  que lo concedes (eligiendo "Permitir" y no "Permitir solo esta vez"),
  no debería volver a preguntar en ese mismo navegador.
- El botón manual nunca desaparece: el reconocimiento es una ayuda
  extra, no un reemplazo — si no te reconoce bien, simplemente tocas
  "Ya respondí" / "Ya la repetí" como antes.

## Lecturas y salmos largos, de corrido y con el ritmo correcto

Antes, cada línea del salmo o cada línea de una lectura larga era un
paso aparte, con su propio clic de "Continuar" — muy lento para lecturas
extensas. Ahora todas las líneas seguidas de un mismo salmo, cántico,
himno o lectura se agrupan en **una sola pantalla** y se leen **de
corrido, automáticamente**, sin pedir ningún clic entre línea y línea.
El botón "Saltar" sigue ahí por si quieres pasar el bloque completo de
una vez.

Además — y esto era el problema del ritmo — la fuente parte los salmos
en renglones cortos por motivos tipográficos, no gramaticales: un mismo
versículo puede venir cortado en dos o tres líneas. Como antes se le
mandaba a la voz **un renglón por vez**, en cada salto de renglón había
un corte seco, como si fuera punto y aparte, muchas veces en mitad de
una frase.

Ahora los renglones seguidos se vuelven a pegar hasta encontrar un final
de frase **de verdad** (punto, admiración, interrogación o puntos
suspensivos, incluso dentro de comillas o paréntesis) y se le manda a la
voz una frase completa por vez. La coma, el punto y coma y los dos
puntos ya **no cortan**: la propia voz les da su pausa natural dentro de
la frase. En pantalla los renglones se siguen viendo tal como vienen.

Medido contra el texto real de un día cualquiera: un cántico que antes
eran 41 cortes secos ahora son 21 frases completas, y en toda la hora,
170 renglones sueltos pasaron a 62 frases — sin perder ni una palabra.

## Por qué sonaba robótico (y no era culpa del modelo)

Arreglar los cortes no bastó: seguía sonando plano. La causa era otra, y
también era nuestra.

Un modelo de voz neuronal decide la entonación **mirando todo el texto
que le entra de una vez**: dónde subir, dónde apoyar, cómo enlazar una
frase con la siguiente, cómo cerrar un párrafo. Si se le manda una frase
suelta por llamada, cada frase le llega sin contexto y la lee como si
fuera la única que existe: tono plano, punto final en cada una, cero
arco. Eso es exactamente lo que suena a robot — y da igual lo bueno que
sea el modelo.

Fish Audio parte el texto internamente en trozos de hasta 300 caracteres
y, con `condition_on_previous_chunks`, cada trozo usa el audio ya
generado como contexto, así que la entonación sigue de corrido. **Pero
eso solo pasa dentro de una misma llamada.** Mandando frase por frase,
esa continuidad no se usaba nunca.

Ahora se le manda el **bloque entero** —el salmo completo, el párrafo
completo— en una sola petición. En el texto real de un día, eso pasa de
62 llamadas por hora a 10, y el bloque más largo son 1.539 caracteres
(el tope antes de partirlo está en 2.500, así que en la práctica casi
nunca hay que partir nada).

Dos cosas más que estaban restando:

- **La velocidad ya no se fuerza acelerando el audio.** Antes se
  reproducía el MP3 a 0,88× con `playbackRate`, que es literalmente
  poner la cinta más lenta: suena artificial. Ahora la velocidad se le
  pide al modelo (`prosody.speed`), que la genera bien de entrada.
- **El valor por defecto pasó de 0,88 a 1.** Ese 0,88 se puso cuando la
  voz era la robótica del navegador, que se entendía mejor frenada; con
  una voz neuronal solo la vuelve pastosa. Si ya habías movido el
  deslizador a mano, se respeta lo que hayas elegido.

Como un bloque tarda un momento en generarse la primera vez, la pantalla
dice "Preparando la voz…" mientras tanto, y la app va pidiendo el audio
del paso siguiente mientras todavía estás en el actual. La segunda vez
que aparece ese texto ya está en caché y suena al instante.

## La voz: Fish Audio

La voz principal es **Fish Audio**, con una voz fija:

```
reference_id: 8d2c17a9b26d4d83888ea67a1ee565b2
model:        s2.1-pro-free
formato:      mp3
```

La app manda el texto a la API de Fish Audio y recibe el audio ya
generado. **No se descarga ni se instala ningún modelo** en el celular
ni en el PC — al revés de lo que pasaba con Kokoro, que bajaba ~90 MB y
además tenía un problema conocido y sin resolver con el español.

Esa voz **nunca se sustituye por otra**: ni por la de por defecto, ni
por una parecida, ni clonando una nueva. Si Fish Audio responde que esa
voz no está disponible, la app lo dice tal cual, con el ID original a la
vista, en vez de cambiar de voz por su cuenta.

### Dónde va la clave de API (y por qué va ahí)

Fish Audio necesita una clave de API. Esta app es un **sitio estático y
público** (GitHub Pages): no tiene servidor propio, así que cualquier
cosa que estuviera dentro de sus archivos la podría leer cualquiera que
entre a la URL. Por eso la clave **no está, ni puede estar, en ningún
archivo del repositorio**.

En su lugar: entra a Ajustes (⚙ arriba a la derecha durante la oración),
pega tu clave en "Clave de Fish Audio" y dale a Guardar. Se guarda
**solo en ese dispositivo** (`localStorage` del navegador), no se sube a
ningún lado, no se escribe en la consola y no sale hacia ningún sitio
que no sea `api.fish.audio`. Tendrás que pegarla una vez en el celular y
una vez en el PC, igual que pasa con los audios de los salmos.

Ten en cuenta lo que sí implica: la clave queda en tu navegador, en tu
dispositivo. Está bien para una app que usas tú; si algún día le pasas
la app instalada a otra persona en ese mismo dispositivo, esa persona
podría llegar a la clave. Si eso te preocupa, se puede borrar desde el
mismo Ajustes con "Borrar la clave de este dispositivo", o montar un
pequeño proxy propio (una función serverless) que guarde la clave del
lado del servidor — dímelo y lo armamos.

### Caché: no se pide dos veces lo mismo

Cada frase que Fish Audio genera se guarda en el dispositivo
(IndexedDB). El salterio rota cada 4 semanas y frases como "Gloria al
Padre…" o "Amén" se repiten decenas de veces al día, así que la segunda
vez suenan al instante y **no gastan cuota de la API**. Además, mientras
suena una frase la app ya va pidiendo la siguiente, para que no haya
silencio entre una y otra.

### Si la voz falla

La app **nunca se queda muda**: si no hay clave puesta, no hay internet
o la API falla, cae a la voz del sistema — pero el motivo queda escrito
en la línea de estado de Ajustes, nunca en silencio. Los estados
posibles son: activa, falta la clave, clave rechazada, sin cuota, voz no
disponible, sin conexión, o error de la API con su detalle.

Y lo más útil para saber a qué atenerse: esa línea **dice quién habló de
verdad la última vez**. Si algo suena robótico y ahí pone "ojo: lo
último que sonó fue la voz del sistema, no Fish Audio", el problema no
es el modelo — es que Fish Audio no llegó a sonar, y el resto de la
línea dice por qué.

Un aviso honesto: **no pude probar la llamada real a `api.fish.audio`
desde mi entorno** (el proxy del sandbox solo deja pasar registros de
paquetes, así que la petición se bloquea antes de salir). El código
sigue exactamente el formato documentado por Fish Audio — POST a
`/v1/tts`, `Authorization: Bearer`, cabecera `model`, cuerpo JSON con
`text` / `reference_id` / `format`, respuesta en bytes de audio — pero
lo único que puede confirmar que funciona de punta a punta es que la
pruebes tú con tu clave. Si el estado en Ajustes te dice algo distinto a
"activa", mándame ese texto exacto y lo ajusto.

### Generar audios por adelantado (Python)

`tts_fish.py` hace lo mismo desde el computador, por si quieres dejar
algún texto fijo ya grabado dentro de la app:

```bash
export FISH_API_KEY="tu-clave"
pip install httpx
python3 tts_fish.py "Hermanos míos, mantengamos firme nuestra confianza."
```

Genera `output.mp3` con esa misma voz. La clave sale de la variable de
entorno `FISH_API_KEY`, nunca del código.

## Qué quedó pendiente

- **Offline real de días futuros**: hoy el service worker cachea la
  app, no el texto del día (que cambia a diario). Se podría precachear
  el día siguiente cuando hay conexión.
- **Compartir tus audios entre celular y PC** sin volver a subirlos:
  requeriría guardarlos en algún lado en la nube (por ejemplo, tu propio
  Google Drive) en vez de solo en el dispositivo.
