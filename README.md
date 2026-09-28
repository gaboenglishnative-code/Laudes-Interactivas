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
  `liturgia.js` reconstruye esas líneas y las clasifica: título, voz
  guía, respuesta del usuario, antífona o lectura — sin depender de
  heurísticas de mayúsculas como el prototipo anterior. Ese archivo lo
  usan tanto el navegador como el generador nocturno de audio, para que
  los dos produzcan exactamente el mismo texto.
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

**Ojo con la voz en local.** El navegador no genera la voz buena: solo
reproduce el audio ya preparado que encuentra en la carpeta `dias/`, al
lado de `index.html`. En el sitio publicado esa carpeta la llena cada
madrugada el workflow "Preparar la voz del día". En tu computador, si
no está, la app lee con la voz del sistema (la robótica). Para oír la
voz buena en local:

- pon al lado de `index.html` una carpeta `dias/` ya generada, o
- genérala tú mismo (necesita Python con `sherpa-onnx soundfile numpy`
  y `npm install jsdom`):

  ```bash
  node herramientas/generar-dia.js --dias 1 --salida . --cache voz-cache
  ```

En Ajustes, la línea de "Voz" dice si el día está preparado. Si
acabas de poner la carpeta y sigue diciendo que no, recarga con
Ctrl+Shift+R.

## Cómo publicarla para usarla desde el celular también

Cualquier hosting de archivos estáticos sirve, por ejemplo GitHub Pages,
Netlify o Vercel (gratis):

1. Sube esta carpeta tal cual a un repositorio de GitHub.
2. Activa GitHub Pages para ese repositorio. Si vas a usar el audio
   pregenerado (ver más abajo), elige **Settings → Pages → Source:
   "GitHub Actions"**; si no, sirve igual desde la rama `main`, carpeta
   raíz.
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

### Por qué reconocía "a veces sí y a veces no" (arreglado)

1. **Solo se comparaba el último pedazo oído.** Si hacías una pausa a
   mitad de la antífona —lo natural en una coma—, el reconocedor la partía
   en dos, y la segunda mitad sola nunca llegaba al 60 % de palabras. Ahora
   se acumula todo lo que dices en el turno.
2. **En Android el reconocedor se corta solo tras cada frase**, y al
   reiniciarlo se perdía lo ya dicho. Ahora se guarda antes de reiniciar.
3. **Se escuchaba siempre en español de España.** Ahora se usa tu región
   (español de Colombia en Bogotá, de México en Ciudad de México…), que
   entiende mucho mejor tu acento. Sale del idioma del navegador o, si
   está en inglés, de tu zona horaria.
4. **Se aceptan palabras casi iguales** ("misericordias" por
   "misericordia"), que el reconocedor confunde a menudo.
5. **En Brave el servicio viene apagado**: antes se reintentaba en bucle
   sin avisar; ahora lo dice en pantalla (en Chrome y Edge sí funciona).

Probado con las mismas palabras exactas contra la lógica anterior:
antífona con pausa en la coma, antífona larga en tres respiros, sesión
cortada por Android, y palabras casi iguales — **las cuatro fallaban
antes y ahora avanzan**.

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

## Audífonos: por qué a veces no sonaba nada (arreglado)

Cuando una página abre el micrófono de unos **audífonos Bluetooth**, el
sistema los pasa a "modo llamada". En Windows eso deja **muda** la salida
estéreo normal; en el celular el sonido baja de calidad o se va por el
altavoz. Al cerrar el micrófono tardan un momento en volver al modo
normal. La app abría el micrófono en tu turno y arrancaba el audio
siguiente justo en ese instante — de ahí el silencio.

Lo que cambió:

- **El micrófono nunca está abierto mientras la app habla**, y antes de
  hablar espera 0,8 s a que los audífonos vuelvan al modo normal.
- **Ajustes → "Micrófono para reconocer"**: con audífonos Bluetooth,
  elige ahí el micrófono del computador o del celular. Así los audífonos
  **nunca** pasan a modo llamada y el audio no se corta. Si tu micrófono
  predeterminado es el de los audífonos, la app lo detecta y lo avisa.
- **Si el audio se pausa solo** (audífonos que se desconectan, el
  Bluetooth que se cae un segundo, una notificación), antes la app se
  quedaba colgada y muda. Ahora dice "En pausa… Toca ▶ para seguir", el
  botón 🔊 pasa a ▶, y sigue exactamente desde donde iba.
- **Si el navegador no deja sonar**, antes se saltaba el texto sin leerlo
  o pasaba a la voz robótica. Ahora pide un toque y lo lee completo.
- **Los botones de los audífonos funcionan**: play/pausa pausa y sigue la
  oración, siguiente/anterior avanzan o retroceden un paso. En el celular
  también salen los controles en la pantalla bloqueada.
- **La voz del sistema ya no puede colgar la app**: en Android a veces
  nunca avisa que terminó; ahora hay un vigilante que sigue solo.

De paso apareció otro fallo: **las antífonas nunca usaban el audio
preparado del día** — siempre las leía la voz robótica del sistema, aunque
el día estuviera listo. Corregido.

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

## Compartirla con otras personas (sin repartir ninguna clave)

Esta es la parte que hace que la app se pueda pasar a quien sea. **Quien
la usa no necesita clave, ni cuenta, ni pagar nada, ni configurar nada.**

La idea aprovecha algo propio de esta app: la Liturgia de las Horas de un
día es **idéntica para todo el mundo**. No hay nada personalizado que
generar por usuario. Así que el audio no se genera cuando alguien reza —
se genera **una vez, de madrugada, para todos**:

1. Una GitHub Action corre cada noche a las 3:00 de Bogotá.
2. Prepara los próximos 3 días: parsea la liturgia y genera el audio de
   cada bloque que falte con una **voz local** (Supertonic, por defecto),
   ahí mismo en la máquina de GitHub — sin ninguna API ni clave — y
   verifica con Whisper que no se haya comido ninguna palabra.
3. Publica el sitio entero —app y audio— en GitHub Pages.

Quien entra descarga mp3 estáticos, como descarga el CSS. Suena
**instantáneo**, porque no hay nada que generar en el momento.

### Qué hay que hacer una sola vez

1. **Settings → Pages → Source: "GitHub Actions"**
   (no "Deploy from a branch"). El workflow publica directamente, así los
   mp3 nunca entran al historial de git y el repositorio no engorda.
2. En la pestaña **Actions**, darle a "Preparar la voz del día" →
   **Run workflow** para la primera vez, sin esperar a la madrugada.

Ya no hace falta ningún secreto: la voz por defecto es local.

### Por qué esto sale gratis

| | |
|---|---|
| GitHub Actions en repos públicos | Gratis, sin límite de minutos — sigue igual tras el cambio de precios de enero de 2026 |
| GitHub Pages | Gratis |
| Voz (Supertonic, local) | Gratis para siempre: corre en la propia máquina de GitHub |

Con la voz local no hay nada con fecha de vencimiento. (Con Fish Audio sí
la había: su modelo gratis va hasta el 30 de noviembre de 2026.) Medidas las 4 semanas anteriores
reales (196 archivos, 1.099.251 bytes), solo **575.670 bytes son texto
único**: los salmos se repiten con el ciclo de 4 semanas del salterio, y
lo que cambia a diario son antífonas y lecturas propias. El generador
nombra cada mp3 con el **hash de su texto**, así que un salmo generado
hace tres semanas se reutiliza solo cuando vuelve a tocar.

Con la voz local eso se traduce en tiempo de máquina, no en dinero: una
vez caliente la caché, cada noche solo hay que generar unos 12 minutos de
audio nuevo. Medido con Kokoro: Laudes completa (23 bloques, 7,7 minutos
de audio) se generó en 4 minutos con 2 núcleos; el runner tiene 4.

### Qué pasa con los días que no están preparados

El generador cubre hoy y los dos días siguientes, que es lo que se reza
en la práctica. Si alguien elige una fecha vieja o futura fuera de esa
ventana, la app hace exactamente lo de siempre: va a la fuente, la
parsea, y la lee con la voz que tenga disponible. Nada se rompe.

### Una nota sobre el parser

`liturgia.js` contiene todo lo que entiende el HTML de la fuente, y lo
cargan **los dos**: el navegador y el generador nocturno. No está
duplicado a propósito — si lo estuviera, cualquier arreglo en un lado
dejaría al otro produciendo un texto distinto, y el audio pregenerado
dejaría de corresponder con lo que la app muestra. Lo mismo hace
`voz-comun.js` con los parámetros de la petición a Fish Audio.

Hay una prueba que verifica justamente eso:

```bash
npm install jsdom
pip install sherpa-onnx soundfile numpy
node herramientas/generar-dia.js --seco                    # qué generaría, sin generar nada
node herramientas/generar-dia.js --dias 1 --horas laudes   # genera una hora de verdad
node herramientas/prueba-e2e.js sitio                      # la app usa el día preparado, o la fuente si no hay
TZ=America/Bogota node herramientas/prueba-audio.js sitio  # audífonos y reconocimiento (18 casos)
```

## La voz: local y gratis

La voz no depende de ninguna API. La genera un modelo que corre en la
propia máquina de GitHub cada madrugada (ver `herramientas/motores_voz.py`).

**Por defecto: Supertonic 3, voz M4** (hombre). Se eligió midiendo, no a
ojo: se probaron 17 combinaciones de voz y ajustes sobre texto real de
Laudes, y a cada una se le puso una nota de **naturalidad** con UTMOS
(un modelo entrenado para imitar cómo califican personas las voces
sintéticas; 1 = robótica, 5 = humana) y se contaron las **palabras mal**
transcribiéndolas con Whisper.

| Voz | Naturalidad | Palabras mal |
|---|---|---|
| **Supertonic 3 · M4** (por defecto) | **3,79** en la muestra · **3,65** en bloques reales | 1,4–2,8 % |
| Supertonic 3 · F1 (mujer) | 3,94 | 1,4 % |
| Kokoro · em_alex (la anterior) | 3,37 · **3,25** en los mismos bloques reales | 2,1 % |
| Piper (4 voces) | 2,24 – 3,32 | 8,5 – 13,5 % |

UTMOS se entrenó sobre todo con inglés: sirve para comparar estas voces
entre sí, no como nota absoluta. La diferencia se mantuvo al comparar con
exactamente los mismos bloques reales (3,65 contra 3,25).

Dos hallazgos de ese ajuste: Supertonic mejora mucho con más **pasos de
refinamiento** (5 pasos → 3,23; 8 → 3,65; 16 → 3,79; 32 ya no mejora), así
que se usan 16. Y trozos más largos o hablar más rápido no ayudaron.

### Verificación: que no se coma palabras

Supertonic, como varios modelos de este tipo, a veces se come palabras
(lo documenta el propio proyecto, y pasó en las pruebas con otra voz).
En una oración eso no se puede permitir, así que **cada trozo generado
se transcribe con Whisper** y se compara con el texto. Si faltan dos o
más palabras seguidas, se regenera con otra semilla (hasta 5 intentos).
Si aun así se las come, ese trozo se lee en dos mitades, cortado en el
punto o la coma más cercanos al centro: con menos texto de una vez el
modelo no se salta nada. Probado a propósito: acepta el audio correcto y las
frases cortas ("Amén." incluido), y rechaza un audio al que le faltan
2 segundos o el final.

En Laudes completa: 45 trozos, 2 regenerados, ninguno con dudas. Con la
verificación, generar una hora de oración tarda ~5 minutos en el runner
de GitHub; una noche normal (~12 minutos de audio nuevo), ~7 minutos.

Licencia de Supertonic: el código es MIT y el modelo **OpenRAIL-M**,
que permite usarlo gratis, también en apps, con restricciones de uso
(nada dañino ni engañoso). Nada de eso afecta a una app para rezar.

### Elegir otra voz

Sin tocar código: **Settings → Secrets and variables → Actions →
Variables → New repository variable**, nombre `MOTOR_VOZ`:

- `supertonic-F1` (mujer, la de mejor nota), o cualquier otra de
  Supertonic: `supertonic-M1` … `supertonic-M5`, `supertonic-F1` … `F5`.
- `kokoro` para volver a la anterior.
- `qwen3-clon`, `omnivoice-clon` o `chatterbox-clon` para los modelos
  grandes (ver abajo).

Cambiar de voz nunca mezcla audios: el nombre de cada archivo lleva la voz
que lo generó.

### Probar los modelos grandes

**Qwen3-TTS**, **OmniVoice** y **Chatterbox** (Apache-2.0 / MIT, todos
corren en CPU) son más pesados y podrían sonar aún más naturales. Sus
pesos están en Hugging Face, así que se prueban en GitHub:

1. **Actions → "Probar voces locales" → Run workflow.** Genera la misma
   muestra con cada motor, con la misma verificación de cada noche.
2. Al terminar, abajo en la página de la ejecución aparece
   **`muestras-voces`**: se descarga y se abre `comparacion.html`. Las
   voces salen **ordenadas por naturalidad** (la misma nota UTMOS de la
   tabla de arriba), con las palabras mal y cuánto tardaría cada una cada
   noche. Supertonic y Kokoro van incluidas para comparar.
3. Si alguna gana, se elige con `MOTOR_VOZ`. Las "-clon" repiten una
   **voz de referencia**: sube `referencia.wav` y `referencia.txt` (vienen
   en el mismo zip) a una carpeta `voz/` del repositorio.

La voz de referencia la crea Qwen3 a partir de una **descripción con
palabras** ("hombre, voz grave y cálida, acento latinoamericano neutro,
lectura pausada, como un sacerdote en una capilla"). No es la voz de
ninguna persona real.

### Fish Audio (opcional)

Sigue disponible: con `MOTOR_VOZ` = `fish` y el secreto `FISH_API_KEY`,
el trabajo nocturno usa Fish Audio como antes. Y en la app, en Ajustes →
**Opciones avanzadas**, quien tenga su propia clave puede usarla para
días que no estén preparados.

### Dónde va la clave de Fish Audio (si se usa)

Hay **dos sitios** donde puede estar la clave, y ninguno es el código:

- **Para todos (lo normal):** en los *Secrets* del repositorio, donde
  solo la ve la GitHub Action de madrugada. Quien reza no necesita nada.
  Es lo explicado arriba.
- **Solo para ti (opcional):** en Ajustes (⚙ durante la oración) puedes
  pegar tu propia clave para que la app genere audio al vuelo en días
  que no estén preparados. Se guarda **solo en ese dispositivo**
  (`localStorage`), no se sube a ningún lado, no se escribe en la
  consola y no sale hacia ningún sitio que no sea `api.fish.audio`.

Esta app es un **sitio estático y público**: no tiene servidor propio,
así que cualquier cosa dentro de sus archivos la podría leer quien entre
a la URL. Por eso la clave **no está, ni puede estar, en ningún archivo
del repositorio**.

Sobre la clave personal de Ajustes: queda en tu navegador, en tu
dispositivo. Está bien para ti; si le pasas ese mismo dispositivo
desbloqueado a otra persona, podría llegar a ella. Se borra desde el
mismo Ajustes con "Borrar la clave de este dispositivo". Para tus amigos
no hace falta: ellos usan el audio ya preparado.

### Caché: no se pide dos veces lo mismo

Cada frase que Fish Audio genera se guarda en el dispositivo
(IndexedDB). El salterio rota cada 4 semanas y frases como "Gloria al
Padre…" o "Amén" se repiten decenas de veces al día, así que la segunda
vez suenan al instante y **no gastan cuota de la API**. Además, mientras
suena una frase la app ya va pidiendo la siguiente, para que no haya
silencio entre una y otra.

### Si la voz falla

La app **nunca se queda muda**. El orden es: audio pregenerado del día →
tu clave personal si la pusiste → voz del sistema. Si no hay nada de lo
anterior, no hay internet o la API falla, cae a la voz del sistema — pero el motivo queda escrito
en la línea de estado de Ajustes, nunca en silencio. Los estados
posibles son: activa, falta la clave, clave rechazada, sin cuota, voz no
disponible, sin conexión, o error de la API con su detalle.

Y lo más útil para saber a qué atenerse: esa línea **dice quién habló de
verdad la última vez** — audio pregenerado, Fish Audio en directo, o la
voz del sistema. Si algo suena robótico y ahí pone "ojo: lo
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
