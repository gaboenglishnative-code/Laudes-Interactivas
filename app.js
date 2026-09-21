(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Configuración de horas y construcción de URL a la fuente original.
  // La fuente (liturgiadelashoras.github.io) es un sitio estático: cada
  // hora litúrgica vive en un archivo .htm fijo por fecha. Leemos ese
  // mismo HTML directamente desde el repositorio en GitHub (que sí envía
  // cabeceras CORS), así que no hace falta ninguna extensión ni inyectar
  // nada en la página original.
  // ---------------------------------------------------------------------

  const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  const HORAS = [
    { id: 'oficio',    nombre: 'Oficio de Lectura', memento: 'Meditación pausada, a cualquier hora' },
    { id: 'laudes',    nombre: 'Laudes',            memento: 'Oración de la mañana' },
    { id: 'tercia',    nombre: 'Tercia',            memento: 'Media mañana' },
    { id: 'sexta',     nombre: 'Sexta',             memento: 'Mediodía' },
    { id: 'nona',      nombre: 'Nona',              memento: 'Media tarde' },
    { id: 'visperas',  nombre: 'Vísperas',          memento: 'Oración de la tarde' },
    { id: 'completas', nombre: 'Completas',         memento: 'Antes de dormir' }
  ];

  const REPO_BASE = 'https://raw.githubusercontent.com/liturgiadelashoras/liturgiadelashoras.github.io/master/sync';

  function construirCarpetaFecha(fecha) {
    const y = fecha.getFullYear();
    const m = MESES[fecha.getMonth()];
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${REPO_BASE}/${y}/${m}/${d}`;
  }

  function construirUrl(fecha, horaId) {
    return `${construirCarpetaFecha(fecha)}/${horaId}.htm`;
  }

  function fechaISO(fecha) {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ---------------------------------------------------------------------
  // Parser: convierte el HTML crudo de la fuente en una lista de pasos.
  // La fuente usa <FONT COLOR="#FF0000"> para rúbricas/etiquetas (V., R.,
  // Ant., títulos de sección) y <FONT COLOR="#000000"> para el texto que
  // se reza. Reconstruimos las líneas a partir de los <BR> respetando
  // ese color heredado.
  // ---------------------------------------------------------------------

  function normalizarEspacios(texto) {
    return texto.replace(/\u00a0/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------
  // Algunos días (fiestas que aplican solo en ciertos países, o que se
  // pueden sustituir por la feria) no tienen el archivo de la hora
  // directamente: en vez de eso, la carpeta del día trae un "index.htm"
  // que ofrece 2 o más carpetas numeradas (1/, 2/...) para elegir. Si
  // pasa eso, lo detectamos y, si hay más de una opción real, se la
  // preguntamos al usuario.
  // ---------------------------------------------------------------------

  function detectarOpcionesDelDia(doc) {
    const cuerpo = doc.getElementById('cuerpo') || doc.body;
    if (!cuerpo) return [];

    const anclas = Array.from(cuerpo.querySelectorAll('a[href]')).filter((a) =>
      /^\d+\/index\.htm$/i.test((a.getAttribute('href') || '').trim())
    );

    return anclas.map((a) => {
      const numero = a.getAttribute('href').trim().match(/^(\d+)\//)[1];
      const contenedor = a.closest('li') || a.parentElement;
      let etiqueta = normalizarEspacios(contenedor.textContent).replace(
        /haga\s*click\s*aqu[ií]\.?/i,
        ''
      ).trim();

      const ul = a.closest('ul');
      if (ul && ul.previousElementSibling) {
        const grupo = normalizarEspacios(ul.previousElementSibling.textContent);
        if (grupo) etiqueta = `${grupo} — ${etiqueta}`;
      }

      return { numero, etiqueta: etiqueta || `Opción ${numero}` };
    });
  }

  async function obtenerHTMLHora(hora, opcion) {
    const url = opcion
      ? `${construirCarpetaFecha(estado.fechaSeleccionada)}/${opcion}/${hora.id}.htm`
      : construirUrl(estado.fechaSeleccionada, hora.id);

    const resp = await fetch(url, { cache: 'no-store' });
    if (resp.ok) return resp.text();

    if (opcion) throw new Error('no-encontrado');

    const urlIndice = `${construirCarpetaFecha(estado.fechaSeleccionada)}/index.htm`;
    const respIndice = await fetch(urlIndice, { cache: 'no-store' });
    if (!respIndice.ok) throw new Error('no-encontrado');

    const htmlIndice = await respIndice.text();
    const doc = new DOMParser().parseFromString(htmlIndice, 'text/html');
    const opciones = detectarOpcionesDelDia(doc);

    if (!opciones.length) throw new Error('no-encontrado');
    if (opciones.length === 1) return obtenerHTMLHora(hora, opciones[0].numero);

    const error = new Error('multiples-opciones');
    error.opciones = opciones;
    throw error;
  }

  function extraerLineas(cuerpo) {
    const lineas = [];
    let actual = [];

    function cerrarLinea() {
      lineas.push(actual);
      actual = [];
    }

    function walk(nodo, color) {
      if (nodo.nodeType === Node.TEXT_NODE) {
        const texto = normalizarEspacios(nodo.textContent);
        if (texto) actual.push({ texto, color });
        return;
      }
      if (nodo.nodeType !== Node.ELEMENT_NODE) return;

      const tag = nodo.tagName;
      // Los <A> en esta fuente solo son botones de tamaño de letra y la
      // barra de navegación entre horas — nunca texto de la oración.
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'A') return;

      if (tag === 'BR') {
        cerrarLinea();
        return;
      }

      let colorHijos = color;
      if (tag === 'FONT') {
        const attrColor = (nodo.getAttribute('color') || '').toUpperCase();
        if (attrColor === '#FF0000') colorHijos = 'rojo';
        else if (attrColor === '#000000') colorHijos = 'negro';
      }

      for (const hijo of nodo.childNodes) {
        walk(hijo, colorHijos);
      }
    }

    walk(cuerpo, 'negro');
    cerrarLinea();
    return lineas;
  }

  function fusionarRuns(runs) {
    const fusion = [];
    for (const run of runs) {
      const ultimo = fusion[fusion.length - 1];
      if (ultimo && ultimo.color === run.color) {
        ultimo.texto = normalizarEspacios(ultimo.texto + ' ' + run.texto);
      } else {
        fusion.push({ texto: run.texto, color: run.color });
      }
    }
    return fusion;
  }

  const RE_V = /^V\.?$/i;
  const RE_R = /^R\.?$/i;
  const RE_ANT = /^Ant\.?\s*\d*\.?$/i;

  function clasificarLinea(runsCrudos) {
    const runs = fusionarRuns(runsCrudos.filter(r => r.texto));
    if (!runs.length) return null;

    const primero = runs[0];

    if (primero.color === 'rojo') {
      if (RE_V.test(primero.texto)) {
        const texto = normalizarEspacios(runs.slice(1).map(r => r.texto).join(' '));
        if (!texto) return null;
        return { tipo: 'voz', etiqueta: 'Guía', texto };
      }
      if (RE_R.test(primero.texto)) {
        const texto = normalizarEspacios(runs.slice(1).map(r => r.texto).join(' '));
        if (!texto) return null;
        return { tipo: 'respuesta', etiqueta: 'Responde tú', texto };
      }
      if (RE_ANT.test(primero.texto)) {
        const texto = normalizarEspacios(runs.slice(1).map(r => r.texto).join(' '));
        if (!texto) return null;
        return { tipo: 'antifona', etiqueta: 'Antífona', texto };
      }
    }

    const todosRojos = runs.every(r => r.color === 'rojo');
    const textoCompleto = normalizarEspacios(runs.map(r => r.texto).join(' '));
    if (!textoCompleto) return null;

    if (todosRojos) {
      return { tipo: 'titulo', etiqueta: 'Sección', texto: textoCompleto };
    }

    return { tipo: 'lectura', etiqueta: 'Se reza', texto: textoCompleto };
  }

  function parsearLiturgia(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cuerpo = doc.getElementById('cuerpo') || doc.body;
    if (!cuerpo) return [];

    const lineas = extraerLineas(cuerpo);
    const pasos = [];
    for (const linea of lineas) {
      const paso = clasificarLinea(linea);
      if (paso) pasos.push(paso);
    }
    return pasos;
  }

  // ---------------------------------------------------------------------
  // Agrupa líneas de lectura consecutivas (versos de un salmo, líneas de
  // un párrafo largo) en un solo paso "de párrafo entero", en vez de uno
  // por cada línea del HTML original. Esto es solo para la PANTALLA y
  // para saber cuándo avanzar solo: cada paso agrupado guarda también sus
  // "partes" originales por separado, así que al leerlo en voz alta se
  // dicen en secuencia, una tras otra, sin que el usuario tenga que darle
  // "Continuar" entre cada línea — ver hablarPartes() más abajo.
  // ---------------------------------------------------------------------

  function agruparLecturasEnParrafos(pasos) {
    const agrupado = [];
    let bufer = null;

    for (const paso of pasos) {
      if (paso.tipo === 'lectura') {
        if (!bufer) {
          bufer = { tipo: 'lectura', etiqueta: paso.etiqueta, texto: paso.texto, partes: [paso.texto] };
          agrupado.push(bufer);
        } else {
          bufer.partes.push(paso.texto);
          // Un solo salto de línea entre versos: así el bloque se ve
          // como se ve en el breviario (verso bajo verso) en vez de con
          // una línea en blanco entre cada renglón.
          bufer.texto += '\n' + paso.texto;
        }
      } else {
        bufer = null;
        agrupado.push(paso);
      }
    }

    return agrupado;
  }

  // ---------------------------------------------------------------------
  // Piezas cantables: detecta títulos de Salmo / Cántico / Himno y agrupa
  // los versos (pasos tipo 'lectura') que le siguen, para poder
  // reemplazarlos por un audio propio cuando el usuario lo asigne.
  // La clave se calcula a partir del propio título, así que un salmo que
  // ya asignaste se reconoce solo la próxima vez que vuelva a aparecer
  // (el salterio rota cada 4 semanas, así que sí se repite tal cual).
  // ---------------------------------------------------------------------

  const RE_PIEZA = /^(Salmo|C[áa]ntico|Himno)\b/i;

  function normalizarClave(texto) {
    return texto
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70);
  }

  function marcarPiezasCantables(pasos) {
    for (let i = 0; i < pasos.length; i++) {
      const paso = pasos[i];
      if (paso.tipo !== 'titulo' || !RE_PIEZA.test(paso.texto)) continue;

      let fin = i;
      let j = i + 1;
      while (j < pasos.length && pasos[j].tipo === 'lectura') {
        fin = j;
        j++;
      }

      // Si no le sigue ningún verso (p. ej. "CÁNTICO EVANGÉLICO" es solo
      // un anuncio, el texto real viene más abajo), no hay nada que
      // reemplazar por audio: no se marca como pieza.
      if (fin > i) {
        paso.pieza = {
          slug: normalizarClave(paso.texto),
          indiceFinVersos: fin
        };
      }
    }
  }

  // ---------------------------------------------------------------------
  // Audios incluidos con la app: el Benedictus (Cántico de Zacarías, al
  // final de Laudes, antes de las preces) y el Salmo 94 (invitatorio,
  // el primer salmo del día) no rotan — se rezan igual siempre — así
  // que van integrados y funcionan de una vez en cualquier dispositivo,
  // sin que el usuario tenga que asignarlos.
  // ---------------------------------------------------------------------

  const AUDIOS_PREDETERMINADOS = {
    'salmo-94-invitacion-a-la-alabanza-divina': 'audios/invitatorio-salmo-94.mp3',
    'cantico-de-zacarias-el-mesias-y-su-precursor-lc-1-68-79': 'audios/benedictus.mp3'
  };

  // ---------------------------------------------------------------------
  // Guardado local de audios propios (IndexedDB — vive en el dispositivo,
  // no se sube a ningún servidor).
  // ---------------------------------------------------------------------

  const DB_NOMBRE = 'modo-rezar-audios';
  const ALMACEN = 'audios';

  function abrirDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('sin-indexeddb')); return; }
      const peticion = indexedDB.open(DB_NOMBRE, 1);
      peticion.onupgradeneeded = () => {
        peticion.result.createObjectStore(ALMACEN, { keyPath: 'slug' });
      };
      peticion.onsuccess = () => resolve(peticion.result);
      peticion.onerror = () => reject(peticion.error);
    });
  }

  async function guardarAudio(slug, archivo) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ALMACEN, 'readwrite');
      tx.objectStore(ALMACEN).put({ slug, blob: archivo, nombre: archivo.name });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function obtenerAudio(slug) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ALMACEN, 'readonly');
      const peticion = tx.objectStore(ALMACEN).get(slug);
      peticion.onsuccess = () => resolve(peticion.result || null);
      peticion.onerror = () => reject(peticion.error);
    });
  }

  async function borrarAudio(slug) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ALMACEN, 'readwrite');
      tx.objectStore(ALMACEN).delete(slug);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function cargarAudiosDePasos(pasos) {
    for (const paso of pasos) {
      if (!paso.pieza) continue;

      try {
        const registro = await obtenerAudio(paso.pieza.slug);
        if (registro && registro.blob) {
          paso.pieza.audioURL = URL.createObjectURL(registro.blob);
          paso.pieza.audioNombre = registro.nombre;
          paso.pieza.esPredeterminado = false;
          continue;
        }
      } catch (e) {
        // Sin IndexedDB disponible: seguimos revisando los predeterminados.
      }

      const predeterminado = AUDIOS_PREDETERMINADOS[paso.pieza.slug];
      if (predeterminado) {
        paso.pieza.audioURL = predeterminado;
        paso.pieza.audioNombre = null;
        paso.pieza.esPredeterminado = true;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Texto a voz
  // ---------------------------------------------------------------------

  // La velocidad venía por defecto en 0.88 porque la voz robótica del
  // navegador se entendía mejor frenada. Con una voz neuronal eso sobra
  // y encima la vuelve pastosa, así que el valor por defecto pasa a 1 —
  // una sola vez, y respetando la velocidad si el usuario ya la había
  // movido a mano.
  (function migrarVelocidad() {
    try {
      if (localStorage.getItem('rezar_velocidad_migrada') === 'true') return;
      const guardada = localStorage.getItem('rezar_velocidad');
      if (guardada === null || parseFloat(guardada) === 0.88) {
        localStorage.setItem('rezar_velocidad', '1');
      }
      localStorage.setItem('rezar_velocidad_migrada', 'true');
    } catch (e) {
      // Sin localStorage se usa el valor por defecto de abajo.
    }
  })();

  const voz = {
    tasa: parseFloat(localStorage.getItem('rezar_velocidad') || '1'),
    ultimoMotor: null,
    autoavanzar: localStorage.getItem('rezar_autoavanzar') !== 'false',
    reconocerVoz: localStorage.getItem('rezar_reconocer') !== 'false',
    vocesListas: false
  };

  // Nombres que suelen indicar una voz masculina entre las voces en
  // español que trae cada navegador/sistema operativo (esto es solo un
  // atajo heurístico: la Web Speech API no siempre expone el género de
  // forma explícita, así que buscamos por nombre).
  const NOMBRES_VOZ_MASCULINA = [
    'jorge', 'diego', 'carlos', 'pablo', 'miguel', 'andrés', 'andres',
    'fernando', 'juan', 'raúl', 'raul', 'ricardo', 'alex', 'álvaro', 'alvaro',
    'male', 'hombre', 'varón', 'varon'
  ];

  function elegirVozEspanola() {
    const voces = speechSynthesis.getVoices();
    const esEspanol = voces.filter(v => v.lang && v.lang.toLowerCase().startsWith('es'));
    if (!esEspanol.length) return null;

    const masculina = esEspanol.find((v) => {
      const nombre = v.name.toLowerCase();
      return NOMBRES_VOZ_MASCULINA.some((n) => nombre.includes(n));
    });
    if (masculina) return masculina;

    return (
      esEspanol.find(v => v.lang.toLowerCase().startsWith('es-es')) ||
      esEspanol[0]
    );
  }

  // Voz principal: Fish Audio (ver voz-fish.js). Si no hay clave de API
  // puesta, no hay internet, o la API falla, se cae a la voz del sistema
  // para que la app nunca se quede muda — pero el motivo queda escrito
  // en la línea de estado de Ajustes, nunca en silencio.
  function hablar(texto, alTerminar, opciones) {
    opciones = opciones || {};

    if (window.VozFish && window.VozFish.tieneClave()) {
      window.VozFish
        .hablar(texto, {
          velocidad: voz.tasa,
          alEmpezar: () => {
            voz.ultimoMotor = 'fish';
            if (opciones.alEmpezar) opciones.alEmpezar();
          }
        })
        .then(() => { if (alTerminar) alTerminar(); })
        .catch(() => {
          // La voz del sistema es el respaldo para no quedarse mudo,
          // pero queda anotado que habló ELLA y no Fish Audio: así la
          // línea de estado no deja creer que "Fish Audio suena mal"
          // cuando en realidad Fish Audio no llegó a hablar.
          voz.ultimoMotor = 'sistema';
          if (opciones.alEmpezar) opciones.alEmpezar();
          actualizarTextoEstadoVoz();
          hablarConNavegador(texto, alTerminar);
        });
      return;
    }

    voz.ultimoMotor = 'sistema';
    if (opciones.alEmpezar) opciones.alEmpezar();
    hablarConNavegador(texto, alTerminar);
  }

  function hablarConNavegador(texto, alTerminar) {
    if (!('speechSynthesis' in window)) {
      if (alTerminar) alTerminar();
      return;
    }
    speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(texto);
    utter.lang = 'es-ES';
    utter.rate = voz.tasa;
    utter.pitch = 1;

    const espanola = elegirVozEspanola();
    if (espanola) utter.voice = espanola;

    let resuelto = false;
    const resolver = () => {
      if (resuelto) return;
      resuelto = true;
      if (alTerminar) alTerminar();
    };

    utter.onend = resolver;
    utter.onerror = resolver;

    speechSynthesis.speak(utter);
  }

  function detenerVoz() {
    if (window.VozFish) window.VozFish.detener();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  // ---------------------------------------------------------------------
  // Frases de verdad, no renglones
  //
  // El HTML de la fuente corta los salmos y las lecturas en renglones
  // cortos por motivos tipográficos, no gramaticales: un mismo versículo
  // puede venir partido en tres líneas. Antes se leía una línea por
  // llamada a la voz, así que en cada salto de renglón había un corte
  // seco, como si fuera punto y aparte — justo en mitad de una frase.
  //
  // Aquí se vuelven a pegar los renglones seguidos hasta encontrar un
  // final de frase real (punto, signo de admiración o de interrogación,
  // puntos suspensivos, incluso si van dentro de comillas o paréntesis).
  // Lo que queda es una frase completa por llamada, así que la voz solo
  // se detiene donde el texto realmente se detiene. La coma, el punto y
  // coma y los dos puntos NO cortan: la propia voz les da su pausa
  // natural dentro de la misma frase.
  //
  // Esto es solo para leer en voz alta: en pantalla los renglones se
  // siguen viendo tal como vienen.
  // ---------------------------------------------------------------------

  const RE_FIN_FRASE = /[.!?…][)\]"'»”’\s]*$/;
  const LARGO_MAX_FRASE = 700;

  function construirFrases(partes) {
    const frases = [];
    let actual = '';

    for (const cruda of partes) {
      const parte = String(cruda == null ? '' : cruda).trim();
      if (!parte) continue;

      actual = actual ? actual + ' ' + parte : parte;

      // Se cierra la frase en un final de frase de verdad, o si ya se
      // hizo muy larga (para que se pueda parar y avanzar sin esperar un
      // bloque enorme).
      if (RE_FIN_FRASE.test(parte) || actual.length >= LARGO_MAX_FRASE) {
        frases.push(actual);
        actual = '';
      }
    }

    if (actual) frases.push(actual);
    return frases;
  }

  function frasesDelPaso(paso) {
    if (!paso) return [];
    if (paso.frases) return paso.frases;

    const partes = (paso.partes && paso.partes.length)
      ? paso.partes
      : String(paso.texto || '').split('\n');

    paso.frases = construirFrases(partes);
    return paso.frases;
  }

  // ---------------------------------------------------------------------
  // Bloques: por qué se le manda el párrafo ENTERO al modelo
  //
  // Un modelo de voz neuronal decide la entonación mirando todo el texto
  // que le entra de una vez: dónde subir, dónde apoyar, cómo enlazar una
  // frase con la siguiente. Si se le mandan frases sueltas, una por
  // llamada, cada frase le llega sin contexto y la lee como si fuera la
  // única que existe — tono plano, punto final en cada una. Eso es lo
  // que suena robótico, y era culpa nuestra, no del modelo.
  //
  // Fish Audio parte el texto internamente en trozos de hasta 300
  // caracteres, pero con condition_on_previous_chunks cada trozo usa el
  // audio anterior como contexto y la entonación sigue de corrido. Eso
  // solo pasa DENTRO de una misma llamada. Así que ahora va el bloque
  // entero (salmo, párrafo, lectura) en una sola petición.
  //
  // Con la voz del sistema es al revés: Android corta los textos largos,
  // así que ahí se sigue yendo frase por frase.
  // ---------------------------------------------------------------------

  const LARGO_MAX_BLOQUE = 2500;

  function agruparEnBloques(frases) {
    const bloques = [];
    let actual = '';

    for (const frase of frases) {
      if (!actual) {
        actual = frase;
        continue;
      }
      if (actual.length + 1 + frase.length > LARGO_MAX_BLOQUE) {
        bloques.push(actual);
        actual = frase;
      } else {
        actual += ' ' + frase;
      }
    }

    if (actual) bloques.push(actual);
    return bloques;
  }

  function trozosDelPaso(paso) {
    const frases = frasesDelPaso(paso);
    if (!frases.length) return [];

    const usaFish = !!(window.VozFish && window.VozFish.tieneClave());
    return usaFish ? agruparEnBloques(frases) : frases;
  }

  // Adelanta el audio del paso siguiente mientras el usuario todavía
  // está en este, para que al avanzar empiece al instante en vez de
  // esperar a que el modelo lo genere.
  function precalentarPasoSiguiente() {
    if (!window.VozFish || !window.VozFish.tieneClave()) return;

    const siguiente = estado.pasos[estado.indice + 1];
    if (!siguiente) return;
    if (siguiente.tipo === 'titulo' || siguiente.pieza) return;

    const trozos = trozosDelPaso(siguiente);
    if (trozos.length) window.VozFish.precalentar(trozos[0], voz.tasa);
  }

  // Lee un paso entero de corrido, automáticamente, sin pedirle nada al
  // usuario entre medio.
  function hablarPartes(paso, alTerminar) {
    const trozos = trozosDelPaso(paso);
    if (!trozos.length) {
      if (alTerminar) alTerminar();
      return;
    }

    let i = 0;
    let empezado = false;

    // Un bloque entero tarda un momento en generarse la primera vez (la
    // segunda ya está en caché y suena al instante). Mejor decirlo que
    // dejar la pantalla muda sin explicación. Solo se toca el texto de
    // estado en las lecturas: en una respuesta o una antífona ahí dice
    // lo que le toca hacer al usuario y no se debe pisar.
    const mandaEnElEstado = paso && paso.tipo === 'lectura';

    if (mandaEnElEstado && window.VozFish && window.VozFish.tieneClave()) {
      el.estado.textContent = 'Preparando la voz…';
    }

    function alEmpezar() {
      if (empezado) return;
      empezado = true;
      if (estado.pasos[estado.indice] !== paso) return;
      if (mandaEnElEstado) el.estado.textContent = 'Escuchando…';
      precalentarPasoSiguiente();
    }

    function siguiente() {
      // Si el usuario ya salió de este paso (saltó, retrocedió, cerró),
      // no seguimos leyendo un paso que ya no está en pantalla.
      if (estado.pasos[estado.indice] !== paso) return;
      if (i >= trozos.length) {
        if (alTerminar) alTerminar();
        return;
      }

      const trozo = trozos[i++];

      // Si el bloque fue tan largo que hubo que partirlo, se va pidiendo
      // el siguiente pedazo mientras suena este.
      if (window.VozFish && i < trozos.length) {
        window.VozFish.precalentar(trozos[i], voz.tasa);
      }

      hablar(trozo, siguiente, { alEmpezar });
    }

    siguiente();
  }

  // ---------------------------------------------------------------------
  // Reconocimiento de voz: detecta cuando el usuario dice la antífona o
  // la respuesta, para avanzar solo. Es una mejora progresiva: si el
  // navegador no lo soporta (Safari de iPhone, por ejemplo) o si el
  // usuario no da permiso de micrófono, simplemente se sigue usando el
  // botón manual, que nunca desaparece.
  // ---------------------------------------------------------------------

  const CtorReconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SOPORTA_RECONOCIMIENTO = !!CtorReconocimiento;

  // Un solo reconocedor para TODA la sesión, creado la primera vez que
  // hace falta y reutilizado siempre después. Antes se creaba uno nuevo
  // en cada turno (cada "Ant." o "R."), y eso es lo que hacía que varios
  // navegadores volvieran a pedir permiso de micrófono una y otra vez:
  // cada objeto SpeechRecognition nuevo dispara su propia verificación
  // de permiso. Con un solo objeto, el permiso se concede una vez y se
  // reutiliza el resto de la sesión.
  let reconocedorGlobal = null;
  let reconociendoActivo = false;
  let expectativaActual = null; // { texto, callback } del turno que se está esperando

  function normalizarParaComparar(texto) {
    return texto
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function coincideSuficiente(esperado, dicho) {
    const palabrasEsperadas = normalizarParaComparar(esperado);
    if (!palabrasEsperadas.length) return false;
    const palabrasDichas = new Set(normalizarParaComparar(dicho));
    let coincidencias = 0;
    for (const palabra of palabrasEsperadas) {
      if (palabrasDichas.has(palabra)) coincidencias++;
    }
    return coincidencias / palabrasEsperadas.length >= 0.6;
  }

  function crearReconocedorSiHaceFalta() {
    if (reconocedorGlobal) return reconocedorGlobal;

    const reconocedor = new CtorReconocimiento();
    reconocedor.lang = 'es-ES';
    reconocedor.continuous = true;
    reconocedor.interimResults = true;
    reconocedor.maxAlternatives = 1;

    reconocedor.onresult = (evento) => {
      if (!expectativaActual) return;
      let transcrito = '';
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        transcrito += ' ' + evento.results[i][0].transcript;
      }
      if (coincideSuficiente(expectativaActual.texto, transcrito)) {
        const cb = expectativaActual.callback;
        expectativaActual = null;
        cb();
      }
    };

    reconocedor.onerror = (evento) => {
      // 'no-speech' (no detectó nada por unos segundos) y 'aborted' son
      // normales mientras el usuario respira o piensa antes de hablar:
      // no hay que apagar el reconocimiento por eso, dejamos que 'onend'
      // lo reinicie solo. Solo cortamos de verdad si el problema es de
      // permisos o de micrófono.
      if (evento.error === 'not-allowed' || evento.error === 'service-not-allowed' || evento.error === 'audio-capture') {
        voz.reconocerVoz = false;
        localStorage.setItem('rezar_reconocer', 'false');
        if (el.checkReconocer) el.checkReconocer.checked = false;
        if (el.notaReconocer) {
          el.notaReconocer.hidden = false;
          el.notaReconocer.textContent = 'No pude usar el micrófono (permiso denegado o no disponible). Actívalo en los ajustes del navegador si quieres esta función.';
        }
        reconociendoActivo = false;
        if (el.indicadorEscucha) el.indicadorEscucha.hidden = true;
      }
      // cualquier otro error: no hacemos nada, 'onend' se encarga de reintentar
    };

    reconocedor.onend = () => {
      if (!reconociendoActivo) return;
      // Pequeña espera antes de reiniciar: arrancar de inmediato en el
      // mismo instante en que terminó puede lanzar un error en algunos
      // navegadores (todavía se está cerrando el anterior).
      setTimeout(() => {
        if (!reconociendoActivo) return;
        try {
          reconocedor.start();
        } catch (e) {
          // 'ya estaba iniciado' u otro error pasajero: reintenta una vez más.
          setTimeout(() => {
            if (reconociendoActivo) {
              try { reconocedor.start(); } catch (e2) { /* se reintentará en el próximo turno */ }
            }
          }, 500);
        }
      }, 250);
    };

    reconocedorGlobal = reconocedor;
    return reconocedor;
  }

  function detenerEscucha() {
    reconociendoActivo = false;
    expectativaActual = null;
    if (el.indicadorEscucha) el.indicadorEscucha.hidden = true;
    if (reconocedorGlobal) {
      try { reconocedorGlobal.stop(); } catch (e) { /* ya estaba detenido */ }
    }
  }

  function escucharTurno(textoEsperado, alConfirmar) {
    if (!voz.reconocerVoz || !SOPORTA_RECONOCIMIENTO) return;

    expectativaActual = { texto: textoEsperado, callback: alConfirmar };
    reconociendoActivo = true;
    if (el.indicadorEscucha) el.indicadorEscucha.hidden = false;

    const r = crearReconocedorSiHaceFalta();
    try {
      r.start();
    } catch (e) {
      // Ya estaba escuchando de un turno anterior: no pasa nada,
      // expectativaActual ya quedó actualizada arriba.
    }
  }

  // Pide el permiso de micrófono una sola vez, en un momento explícito
  // (el usuario toca un botón), en vez de que aparezca de sorpresa a
  // mitad de una oración. El permiso en sí lo recuerda el navegador, no
  // esta app — esto solo deja constancia en pantalla de que ya se
  // concedió, para que el usuario sepa que no hace falta repetirlo.
  async function activarMicrofono() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('sin-getusermedia');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    localStorage.setItem('rezar_mic_probado', 'true');
  }

  // ---------------------------------------------------------------------
  // Estado y referencias del DOM
  // ---------------------------------------------------------------------

  const el = {
    inicio: document.getElementById('pantalla-inicio'),
    carga: document.getElementById('pantalla-carga'),
    error: document.getElementById('pantalla-error'),
    opciones: document.getElementById('pantalla-opciones'),
    oracion: document.getElementById('pantalla-oracion'),

    campoFecha: document.getElementById('campo-fecha'),
    btnHoy: document.getElementById('btn-hoy'),
    listaHoras: document.getElementById('lista-horas'),
    notaInstalar: document.getElementById('nota-instalar'),
    btnInstalar: document.getElementById('btn-instalar'),

    textoCarga: document.getElementById('texto-carga'),
    textoError: document.getElementById('texto-error'),
    btnVolverError: document.getElementById('btn-volver-error'),

    listaOpciones: document.getElementById('lista-opciones'),
    btnVolverOpciones: document.getElementById('btn-volver-opciones'),

    oracionTitulo: document.getElementById('oracion-titulo'),
    regletaProgreso: document.getElementById('regleta-progreso'),
    panelConfig: document.getElementById('panel-config'),
    btnConfig: document.getElementById('btn-config'),
    rangoVelocidad: document.getElementById('rango-velocidad'),
    checkAutoavanzar: document.getElementById('check-autoavanzar'),
    checkReconocer: document.getElementById('check-reconocer'),
    notaReconocer: document.getElementById('nota-reconocer'),
    btnActivarMic: document.getElementById('btn-activar-mic'),
    estadoVoz: document.getElementById('estado-voz'),
    campoClaveVoz: document.getElementById('campo-clave-voz'),
    btnGuardarClaveVoz: document.getElementById('btn-guardar-clave-voz'),
    btnBorrarClaveVoz: document.getElementById('btn-borrar-clave-voz'),
    indicadorEscucha: document.getElementById('indicador-escucha'),

    piezaAudio: document.getElementById('pieza-audio'),
    reproductorPieza: document.getElementById('reproductor-pieza'),
    piezaAudioNombre: document.getElementById('pieza-audio-nombre'),
    btnCambiarAudio: document.getElementById('btn-cambiar-audio'),
    btnQuitarAudio: document.getElementById('btn-quitar-audio'),
    piezaAsignar: document.getElementById('pieza-asignar'),
    btnAsignarAudio: document.getElementById('btn-asignar-audio'),
    inputAudio: document.getElementById('input-audio'),

    etiqueta: document.getElementById('oracion-etiqueta'),
    texto: document.getElementById('oracion-texto'),
    estado: document.getElementById('oracion-estado'),
    folio: document.getElementById('oracion-folio'),

    btnAtras: document.getElementById('btn-atras'),
    btnEscuchar: document.getElementById('btn-escuchar'),
    btnContinuar: document.getElementById('btn-continuar'),
    btnSalir: document.getElementById('btn-salir')
  };

  const estado = {
    fechaSeleccionada: new Date(),
    pasos: [],
    indice: 0,
    horaActual: null
  };

  function mostrarPantalla(pantalla) {
    for (const p of [el.inicio, el.carga, el.error, el.opciones, el.oracion]) {
      p.hidden = p !== pantalla;
    }
  }

  // ---------------------------------------------------------------------
  // Pantalla de inicio
  // ---------------------------------------------------------------------

  function renderListaHoras() {
    el.listaHoras.innerHTML = '';
    for (const hora of HORAS) {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'hora-item';
      boton.innerHTML = `
        <span class="hora-texto">
          <span class="hora-nombre">${hora.nombre}</span>
          <span class="hora-memento">${hora.memento}</span>
        </span>
        <span class="hora-flecha" aria-hidden="true">→</span>
      `;
      boton.addEventListener('click', () => iniciarOracion(hora));
      el.listaHoras.appendChild(boton);
    }
  }

  function initSelectorFecha() {
    el.campoFecha.value = fechaISO(estado.fechaSeleccionada);
    el.campoFecha.addEventListener('change', () => {
      if (!el.campoFecha.value) return;
      const [y, m, d] = el.campoFecha.value.split('-').map(Number);
      estado.fechaSeleccionada = new Date(y, m - 1, d);
    });
    el.btnHoy.addEventListener('click', () => {
      estado.fechaSeleccionada = new Date();
      el.campoFecha.value = fechaISO(estado.fechaSeleccionada);
    });
  }

  // ---------------------------------------------------------------------
  // Carga y arranque de una hora
  // ---------------------------------------------------------------------

  async function iniciarOracion(hora) {
    estado.horaActual = hora;
    mostrarPantalla(el.carga);
    el.textoCarga.textContent = `Buscando ${hora.nombre.toLowerCase()}…`;

    try {
      const html = await obtenerHTMLHora(hora);
      await procesarYMostrar(hora, html);
    } catch (err) {
      if (err && err.opciones) {
        mostrarSelectorOpciones(hora, err.opciones);
        return;
      }
      el.textoError.textContent =
        `No encontré el texto de ${hora.nombre.toLowerCase()} para el ${el.campoFecha.value}. ` +
        `Puede que esa hora no exista para este día, o que la fuente aún no la haya publicado.`;
      mostrarPantalla(el.error);
    }
  }

  async function procesarYMostrar(hora, html) {
    const pasosCrudos = parsearLiturgia(html);
    if (!pasosCrudos.length) throw new Error('vacio');

    const pasos = agruparLecturasEnParrafos(pasosCrudos);
    marcarPiezasCantables(pasos);
    await cargarAudiosDePasos(pasos);

    estado.pasos = pasos;
    estado.indice = 0;
    el.oracionTitulo.textContent = hora.nombre;
    mostrarPantalla(el.oracion);
    mostrarPaso();
  }

  function mostrarSelectorOpciones(hora, opciones) {
    el.listaOpciones.innerHTML = '';
    for (const opcion of opciones) {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'hora-item';
      boton.innerHTML = `
        <span class="hora-texto">
          <span class="hora-nombre">${opcion.etiqueta}</span>
        </span>
        <span class="hora-flecha" aria-hidden="true">→</span>
      `;
      boton.addEventListener('click', () => continuarConOpcion(hora, opcion.numero));
      el.listaOpciones.appendChild(boton);
    }
    mostrarPantalla(el.opciones);
  }

  async function continuarConOpcion(hora, numero) {
    mostrarPantalla(el.carga);
    el.textoCarga.textContent = `Buscando ${hora.nombre.toLowerCase()}…`;
    try {
      const html = await obtenerHTMLHora(hora, numero);
      await procesarYMostrar(hora, html);
    } catch (err) {
      el.textoError.textContent = `No encontré el texto de ${hora.nombre.toLowerCase()} para esa opción.`;
      mostrarPantalla(el.error);
    }
  }

  el.btnVolverOpciones.addEventListener('click', () => mostrarPantalla(el.inicio));

  el.btnVolverError.addEventListener('click', () => mostrarPantalla(el.inicio));

  // ---------------------------------------------------------------------
  // Reproducción paso a paso
  // ---------------------------------------------------------------------

  function actualizarProgreso() {
    const pct = estado.pasos.length
      ? Math.round(((estado.indice) / estado.pasos.length) * 100)
      : 0;
    el.regletaProgreso.style.width = pct + '%';
    el.folio.textContent = `${estado.indice + 1} · ${estado.pasos.length}`;
  }

  function mostrarPaso() {
    detenerVoz();
    detenerEscucha();
    el.piezaAudio.hidden = true;
    el.piezaAsignar.hidden = true;
    el.reproductorPieza.pause();
    el.reproductorPieza.onended = null;

    if (estado.indice >= estado.pasos.length) {
      el.etiqueta.textContent = 'Fin';
      el.texto.classList.remove('es-titulo');
      el.texto.textContent = `${estado.horaActual.nombre} ha terminado.`;
      el.estado.textContent = '';
      el.estado.classList.remove('es-turno');
      el.regletaProgreso.style.width = '100%';
      el.folio.textContent = '';
      el.btnContinuar.textContent = 'Volver al índice';
      el.btnContinuar.onclick = () => mostrarPantalla(el.inicio);
      el.btnEscuchar.hidden = true;
      return;
    }

    if (estado.indice < 0) estado.indice = 0;

    const paso = estado.pasos[estado.indice];
    el.etiqueta.textContent = paso.etiqueta;
    el.texto.textContent = paso.texto;
    el.texto.classList.toggle('es-titulo', paso.tipo === 'titulo');
    el.btnEscuchar.hidden = paso.tipo === 'titulo';
    actualizarProgreso();

    el.btnContinuar.onclick = avanzar;

    if (paso.tipo === 'respuesta') {
      el.estado.textContent = 'Tu turno';
      el.estado.classList.add('es-turno');
      el.btnContinuar.textContent = 'Ya respondí';
      escucharTurno(paso.texto, () => {
        if (estado.pasos[estado.indice] === paso) avanzar();
      });
      return;
    }

    if (paso.tipo === 'antifona') {
      el.estado.textContent = 'Escucha…';
      el.estado.classList.remove('es-turno');
      el.btnContinuar.textContent = 'Ya la repetí';
      hablar(paso.texto, () => {
        if (estado.pasos[estado.indice] !== paso) return;
        el.estado.textContent = 'Repite la antífona';
        el.estado.classList.add('es-turno');
        escucharTurno(paso.texto, () => {
          if (estado.pasos[estado.indice] === paso) avanzar();
        });
      });
      return;
    }

    if (paso.tipo === 'titulo' && paso.pieza) {
      mostrarPasoPieza(paso);
      return;
    }

    if (paso.tipo === 'titulo') {
      el.estado.textContent = '';
      el.estado.classList.remove('es-turno');
      el.btnContinuar.textContent = 'Continuar';
      return;
    }

    // lectura: se lee sola, de corrido (todas sus líneas/versos en
    // secuencia, sin pedir clics entre medio) y avanza al terminar,
    // salvo que el usuario haya desactivado el avance automático.
    el.estado.textContent = 'Escuchando…';
    el.estado.classList.remove('es-turno');
    el.btnContinuar.textContent = 'Saltar';

    hablarPartes(paso, () => {
      if (!voz.autoavanzar) return;
      setTimeout(() => {
        if (estado.pasos[estado.indice] === paso) {
          estado.indice++;
          mostrarPaso();
        }
      }, 420);
    });
  }

  function avanzar() {
    estado.indice++;
    mostrarPaso();
  }

  function retroceder() {
    estado.indice = Math.max(0, estado.indice - 1);
    mostrarPaso();
  }

  function salir() {
    detenerVoz();
    detenerEscucha();
    mostrarPantalla(el.inicio);
  }

  // ---------------------------------------------------------------------
  // Piezas cantables: reproducir el audio propio, o si no hay, ofrecer
  // asignar uno y mientras tanto seguir línea por línea como siempre.
  // ---------------------------------------------------------------------

  let piezaPendienteAsignar = null;

  function mostrarPasoPieza(paso) {
    el.estado.textContent = '';
    el.estado.classList.remove('es-turno');

    if (paso.pieza.audioURL) {
      el.piezaAudio.hidden = false;
      el.btnQuitarAudio.hidden = !!paso.pieza.esPredeterminado;
      el.piezaAudioNombre.textContent = paso.pieza.esPredeterminado
        ? 'Audio incluido con la app'
        : (paso.pieza.audioNombre ? `Archivo: ${paso.pieza.audioNombre}` : '');
      el.reproductorPieza.src = paso.pieza.audioURL;
      el.reproductorPieza.currentTime = 0;
      el.btnContinuar.textContent = 'Saltar al final';
      el.btnContinuar.onclick = () => saltarPieza(paso);
      el.reproductorPieza.onended = () => {
        if (voz.autoavanzar) saltarPieza(paso);
      };
      el.reproductorPieza.play().catch(() => { /* el usuario le da play manualmente */ });
    } else {
      el.piezaAsignar.hidden = false;
      el.btnContinuar.textContent = 'Continuar';
      el.btnContinuar.onclick = avanzar;
    }
  }

  function saltarPieza(paso) {
    el.reproductorPieza.pause();
    estado.indice = paso.pieza.indiceFinVersos + 1;
    mostrarPaso();
  }

  function pasoPiezaActual() {
    const paso = estado.pasos[estado.indice];
    return paso && paso.tipo === 'titulo' && paso.pieza ? paso : null;
  }

  el.btnAsignarAudio.addEventListener('click', () => {
    piezaPendienteAsignar = pasoPiezaActual();
    if (piezaPendienteAsignar) el.inputAudio.click();
  });

  el.btnCambiarAudio.addEventListener('click', () => {
    piezaPendienteAsignar = pasoPiezaActual();
    if (piezaPendienteAsignar) el.inputAudio.click();
  });

  el.inputAudio.addEventListener('change', async () => {
    const archivo = el.inputAudio.files[0];
    el.inputAudio.value = '';
    if (!archivo || !piezaPendienteAsignar) return;

    await guardarAudio(piezaPendienteAsignar.pieza.slug, archivo);
    piezaPendienteAsignar.pieza.audioURL = URL.createObjectURL(archivo);
    piezaPendienteAsignar.pieza.audioNombre = archivo.name;
    piezaPendienteAsignar.pieza.esPredeterminado = false;

    if (pasoPiezaActual() === piezaPendienteAsignar) mostrarPaso();
    piezaPendienteAsignar = null;
  });

  el.btnQuitarAudio.addEventListener('click', async () => {
    const paso = pasoPiezaActual();
    if (!paso) return;
    await borrarAudio(paso.pieza.slug);
    const predeterminado = AUDIOS_PREDETERMINADOS[paso.pieza.slug];
    paso.pieza.audioURL = predeterminado || null;
    paso.pieza.audioNombre = null;
    paso.pieza.esPredeterminado = !!predeterminado;
    mostrarPaso();
  });

  el.btnAtras.addEventListener('click', retroceder);
  el.btnSalir.addEventListener('click', salir);
  el.btnEscuchar.addEventListener('click', () => {
    const paso = estado.pasos[estado.indice];
    if (paso) hablarPartes(paso, () => {});
  });

  // ---------------------------------------------------------------------
  // Voz de Fish Audio: estado visible y clave de API
  //
  // La clave no está —ni puede estar— dentro de los archivos de la app:
  // esto es un sitio estático y público, cualquiera podría leerla. Se
  // escribe una sola vez aquí y se guarda únicamente en este dispositivo
  // (localStorage). Nunca se muestra entera de vuelta, nunca se imprime
  // en consola y nunca sale hacia otro sitio que no sea api.fish.audio.
  // ---------------------------------------------------------------------

  function actualizarTextoEstadoVoz(detalle) {
    if (!el.estadoVoz) return;

    if (!window.VozFish) {
      el.estadoVoz.textContent = 'Voz Fish Audio: no se pudo cargar el módulo de voz. Usando la voz del sistema.';
      return;
    }

    const d = detalle || window.VozFish.obtenerEstado();
    switch (d.fase) {
      case 'lista':
        el.estadoVoz.textContent = 'Voz Fish Audio: activa.';
        break;
      case 'sin-clave':
        el.estadoVoz.textContent = 'Voz Fish Audio: falta tu clave de API (pégala aquí abajo). Mientras tanto se usa la voz del sistema.';
        break;
      case 'error-clave':
        el.estadoVoz.textContent = 'Fish Audio rechazó la clave de API. Revísala aquí abajo. Mientras tanto se usa la voz del sistema.';
        break;
      case 'error-cuota':
        el.estadoVoz.textContent = 'La cuenta de Fish Audio no tiene saldo o cuota disponible. Mientras tanto se usa la voz del sistema.';
        break;
      case 'error-voz':
        el.estadoVoz.textContent = window.VozFish.MSG_VOZ_NO_DISPONIBLE + ' Mientras tanto se usa la voz del sistema.';
        break;
      case 'error-red':
        el.estadoVoz.textContent = 'No pude contactar a Fish Audio (sin conexión, o el navegador bloqueó la petición). Mientras tanto se usa la voz del sistema.';
        break;
      case 'error-api':
        el.estadoVoz.textContent = 'Fish Audio devolvió un error. Detalle: ' + (d.error || 'desconocido') + '. Mientras tanto se usa la voz del sistema.';
        break;
      default:
        el.estadoVoz.textContent = 'Voz Fish Audio: en espera.';
    }

    // Lo más útil para saber a qué atenerse: quién habló de verdad la
    // última vez. Si suena robótico y aquí dice "la voz del sistema",
    // el problema no es Fish Audio — es que Fish Audio no llegó a sonar.
    if (voz.ultimoMotor === 'fish') {
      el.estadoVoz.textContent += ' — lo último que sonó lo generó Fish Audio.';
    } else if (voz.ultimoMotor === 'sistema') {
      el.estadoVoz.textContent += ' — ojo: lo último que sonó fue la voz del sistema, no Fish Audio.';
    }
  }

  window.addEventListener('vozfish-estado', (e) => actualizarTextoEstadoVoz(e.detail));

  function refrescarUIClave() {
    if (!el.campoClaveVoz) return;
    const puesta = !!(window.VozFish && window.VozFish.tieneClave());
    el.campoClaveVoz.value = '';
    el.campoClaveVoz.placeholder = puesta
      ? 'Clave guardada en este dispositivo ✓'
      : 'Pega aquí tu clave de Fish Audio';
    if (el.btnBorrarClaveVoz) el.btnBorrarClaveVoz.hidden = !puesta;
  }

  if (el.btnGuardarClaveVoz) {
    el.btnGuardarClaveVoz.addEventListener('click', () => {
      const valor = el.campoClaveVoz ? el.campoClaveVoz.value : '';
      if (!valor.trim()) return;
      if (window.VozFish && window.VozFish.guardarClave(valor)) {
        refrescarUIClave();
        actualizarTextoEstadoVoz();
      }
    });
  }

  if (el.btnBorrarClaveVoz) {
    el.btnBorrarClaveVoz.addEventListener('click', () => {
      if (window.VozFish) window.VozFish.borrarClave();
      refrescarUIClave();
      actualizarTextoEstadoVoz();
    });
  }

  // voz-fish.js carga con defer, igual que este archivo, así que ya
  // debería existir; el reintento corto es solo por si el archivo tarda.
  (function esperarVozFish(intentosRestantes) {
    if (window.VozFish || intentosRestantes <= 0) {
      refrescarUIClave();
      actualizarTextoEstadoVoz();
      return;
    }
    setTimeout(() => esperarVozFish(intentosRestantes - 1), 300);
  })(10);

  // ---------------------------------------------------------------------
  // Ajustes de voz
  // ---------------------------------------------------------------------

  el.rangoVelocidad.value = String(voz.tasa);
  el.checkAutoavanzar.checked = voz.autoavanzar;

  el.btnConfig.addEventListener('click', () => {
    el.panelConfig.hidden = !el.panelConfig.hidden;
  });

  el.rangoVelocidad.addEventListener('input', () => {
    voz.tasa = parseFloat(el.rangoVelocidad.value);
    localStorage.setItem('rezar_velocidad', String(voz.tasa));
  });

  el.checkAutoavanzar.addEventListener('change', () => {
    voz.autoavanzar = el.checkAutoavanzar.checked;
    localStorage.setItem('rezar_autoavanzar', String(voz.autoavanzar));
  });

  if (!SOPORTA_RECONOCIMIENTO) {
    voz.reconocerVoz = false;
    el.checkReconocer.checked = false;
    el.checkReconocer.disabled = true;
    el.notaReconocer.hidden = false;
    el.notaReconocer.textContent = 'Este navegador no permite reconocimiento de voz automático (por ejemplo, Safari en iPhone todavía no lo soporta). Los botones normales siguen funcionando igual.';
  } else {
    el.checkReconocer.checked = voz.reconocerVoz;
  }

  el.checkReconocer.addEventListener('change', () => {
    voz.reconocerVoz = el.checkReconocer.checked;
    localStorage.setItem('rezar_reconocer', String(voz.reconocerVoz));
    if (!voz.reconocerVoz) detenerEscucha();
  });

  if (el.btnActivarMic) {
    if (!SOPORTA_RECONOCIMIENTO || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.btnActivarMic.hidden = true;
    } else {
      if (localStorage.getItem('rezar_mic_probado') === 'true') {
        el.btnActivarMic.textContent = 'Micrófono activado ✓';
      }
      el.btnActivarMic.addEventListener('click', async () => {
        el.btnActivarMic.textContent = 'Pidiendo permiso…';
        try {
          await activarMicrofono();
          el.btnActivarMic.textContent = 'Micrófono activado ✓';
        } catch (e) {
          el.btnActivarMic.textContent = 'No se pudo activar — revisa los permisos del navegador';
        }
      });
    }
  }

  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => { voz.vocesListas = true; };
  }

  // ---------------------------------------------------------------------
  // Instalación como app (PWA) — funciona igual en celular o en PC
  // ---------------------------------------------------------------------

  let eventoInstalacion = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    eventoInstalacion = e;
    el.notaInstalar.hidden = false;
  });

  el.btnInstalar.addEventListener('click', async () => {
    if (!eventoInstalacion) return;
    eventoInstalacion.prompt();
    await eventoInstalacion.userChoice;
    eventoInstalacion = null;
    el.notaInstalar.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    el.notaInstalar.hidden = true;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ---------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------

  renderListaHoras();
  initSelectorFecha();
  mostrarPantalla(el.inicio);
})();
