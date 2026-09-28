(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // El parser, las URLs de la fuente y la construcción de frases y
  // bloques viven en liturgia.js, NO aquí. Ese mismo archivo lo carga el
  // generador nocturno que prepara el audio (herramientas/generar-dia.js),
  // así que navegador y generador producen exactamente el mismo texto.
  // Si estuviera duplicado, cualquier arreglo en un lado dejaría al otro
  // generando audio que ya no corresponde con lo que se muestra.
  // ---------------------------------------------------------------------

  const L = window.Liturgia;

  const HORAS = L.HORAS;
  const fechaISO = L.fechaISO;
  const frasesDelPaso = L.frasesDelPaso;
  const agruparEnBloques = L.agruparEnBloques;

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
    cuandoMicLibre(() => hablarYa(texto, alTerminar, opciones));
  }

  function hablarYa(texto, alTerminar, opciones) {
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
    let vigilante = null;
    const resolver = () => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(vigilante);
      if (alTerminar) alTerminar();
    };

    utter.onend = resolver;
    utter.onerror = resolver;

    // Vigilante: la voz del sistema en Android (sobre todo con audífonos
    // Bluetooth) a veces nunca avisa que terminó, y la app se quedaba
    // esperando para siempre. Si tarda mucho más de lo que debería, se da
    // por terminada. ~12 caracteres por segundo a velocidad normal.
    const esperado = (texto.length / 12) / (voz.tasa || 1);
    vigilante = setTimeout(() => {
      if (resuelto) return;
      try { speechSynthesis.cancel(); } catch (e) { /* nada */ }
      resolver();
    }, Math.max(4000, esperado * 2000 + 2500));

    speechSynthesis.speak(utter);
  }

  function detenerVoz() {
    if (window.VozPrevia) window.VozPrevia.detener();
    if (window.VozFish) window.VozFish.detener();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  // ---------------------------------------------------------------------
  // Qué se le manda a la voz, y en qué tamaño
  //
  // construirFrases() y agruparEnBloques() están en liturgia.js. La
  // diferencia está en el tamaño según quién hable:
  //
  //  - Fish Audio recibe el BLOQUE entero (salmo o párrafo completo). Un
  //    modelo neuronal decide la entonación mirando todo el texto que le
  //    entra de una vez; con frases sueltas cada una le llega sin
  //    contexto y suena plana. Internamente parte en trozos de 300
  //    caracteres, pero con condition_on_previous_chunks encadena la
  //    entonación — y eso solo pasa dentro de UNA llamada.
  //
  //  - La voz del sistema recibe FRASES sueltas, porque Android corta
  //    los textos largos.
  // ---------------------------------------------------------------------

  // ¿Este paso ya trae su audio hecho por el generador nocturno?
  function tienePregenerado(paso) {
    return !!(window.VozPrevia && paso && paso.audios && paso.audios.length);
  }

  function trozosDelPaso(paso) {
    // Con audio pregenerado, los trozos son los bloques — que es como
    // los partió el generador, así que paso.audios[i] corresponde a
    // trozos[i]. Sin él, depende de quién vaya a hablar.
    if (tienePregenerado(paso)) return L.bloquesDelPaso(paso);

    const frases = frasesDelPaso(paso);
    if (!frases.length) return [];

    const usaFish = !!(window.VozFish && window.VozFish.tieneClave());
    return usaFish ? agruparEnBloques(frases) : frases;
  }

  // Adelanta el audio del paso siguiente mientras el usuario todavía
  // está en este, para que al avanzar empiece al instante.
  function precalentarPasoSiguiente() {
    const siguiente = estado.pasos[estado.indice + 1];
    if (!siguiente) return;
    if (siguiente.tipo === 'titulo' || siguiente.pieza) return;

    if (tienePregenerado(siguiente)) {
      window.VozPrevia.precalentar(siguiente.audios[0]);
      return;
    }

    if (!window.VozFish || !window.VozFish.tieneClave()) return;
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
    const pregenerado = tienePregenerado(paso);

    // Solo se avisa cuando de verdad hay que esperar a que el modelo
    // genere. Con audio pregenerado no hay espera: es un mp3 más.
    if (mandaEnElEstado && !pregenerado && window.VozFish && window.VozFish.tieneClave()) {
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

      const indice = i;
      const trozo = trozos[i++];

      // Si el bloque fue tan largo que hubo que partirlo, se va pidiendo
      // el siguiente pedazo mientras suena este.
      if (i < trozos.length) {
        if (pregenerado) window.VozPrevia.precalentar(paso.audios[i]);
        else if (window.VozFish) window.VozFish.precalentar(trozos[i], voz.tasa);
      }

      // Audio ya hecho: se reproduce tal cual, sin llamar a ninguna API
      // ni necesitar clave. Si ese archivo faltara o no cargara, se cae
      // al camino normal en vez de saltarse el texto.
      const url = pregenerado ? paso.audios[indice] : null;
      if (url) {
        cuandoMicLibre(() => {
          window.VozPrevia
            .hablar(url, { velocidad: voz.tasa, alEmpezar: () => { voz.ultimoMotor = 'pregenerado'; alEmpezar(); } })
            .then(siguiente)
            .catch(() => hablar(trozo, siguiente, { alEmpezar }));
        });
        return;
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
  //
  // Por qué "a veces sí y a veces no" reconocía, y qué cambió:
  //
  //  1. Solo se comparaba el ÚLTIMO fragmento oído. Si el usuario hacía
  //     una pausa a mitad de la antífona (lo natural en una coma o un
  //     punto), el reconocedor la partía en dos, y la segunda mitad sola
  //     nunca llegaba al 60 %. Ahora se acumula todo lo dicho en el turno.
  //  2. En Android el reconocedor se corta solo tras cada frase aunque se
  //     le pida modo continuo, y al reiniciarlo se perdía lo ya dicho.
  //     Ahora lo oído en cada sesión se guarda antes de reiniciar.
  //  3. Se escuchaba en español de España siempre. Ahora se usa la región
  //     del usuario (español de Colombia en Bogotá, de México en CDMX...),
  //     que reconoce mucho mejor su acento.
  //  4. Al pasar de turno se usaba stop(), que todavía entrega lo último
  //     que oyó — y eso llegaba como si fuera la respuesta del turno
  //     siguiente. Ahora se usa abort() y cada sesión sabe de qué turno es.
  //  5. Se toleran palabras casi iguales ("misericordias" por
  //     "misericordia"), que el reconocedor confunde a menudo.
  // ---------------------------------------------------------------------

  const CtorReconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SOPORTA_RECONOCIMIENTO = !!CtorReconocimiento;

  // Cuánto se espera, tras cerrar el micrófono, antes de volver a hablar.
  // Al abrir el micrófono, los audífonos Bluetooth pasan a "modo llamada"
  // (en Windows, la salida estéreo incluso se queda muda), y al cerrarlo
  // tardan un momento en volver al modo normal. Si el audio arranca justo
  // en ese instante, en muchos equipos no suena nada. Esta espera es la
  // mitad del arreglo de "con audífonos a veces no suena nada"; la otra
  // mitad es no tener nunca el micrófono abierto mientras la app habla.
  const ASENTAR_MIC_MS = 800;

  const UMBRAL_COINCIDENCIA = 0.55;
  const CLAVE_MIC = 'rezar_mic_dispositivo';

  const rec = {
    obj: null,
    sesionActiva: false,
    arrancando: false,
    turno: null,          // { id, texto, alConfirmar, acumulado }
    sesionDeTurno: 0,     // id del turno para el que se abrió la sesión en curso
    textoSesion: '',
    ultimoFin: 0,         // cuándo se cerró el micrófono por última vez
    usadoAlgunaVez: false,
    erroresRed: 0,
    reintentos: 0,
    pista: null,          // pista del micrófono elegido en Ajustes, si hay
    esperasMic: [],
    contador: 0
  };

  // Región para el reconocimiento: primero el idioma del navegador si
  // trae país (es-CO, es-MX...); si no, se deduce de la zona horaria.
  const ZONA_A_REGION = {
    'America/Bogota': 'es-CO', 'America/Mexico_City': 'es-MX', 'America/Monterrey': 'es-MX',
    'America/Tijuana': 'es-MX', 'America/Cancun': 'es-MX', 'America/Merida': 'es-MX',
    'America/Chihuahua': 'es-MX', 'America/Lima': 'es-PE', 'America/Santiago': 'es-CL',
    'America/Caracas': 'es-VE', 'America/Guayaquil': 'es-EC', 'America/La_Paz': 'es-BO',
    'America/Asuncion': 'es-PY', 'America/Montevideo': 'es-UY', 'America/Guatemala': 'es-GT',
    'America/Costa_Rica': 'es-CR', 'America/Panama': 'es-PA', 'America/El_Salvador': 'es-SV',
    'America/Tegucigalpa': 'es-HN', 'America/Managua': 'es-NI', 'America/Santo_Domingo': 'es-DO',
    'America/Puerto_Rico': 'es-PR', 'Europe/Madrid': 'es-ES', 'Atlantic/Canary': 'es-ES'
  };

  function idiomaReconocimiento() {
    const langs = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language || ''];
    for (const l of langs) {
      if (/^es-[a-z]{2}$/i.test(l)) return 'es-' + l.slice(3).toUpperCase();
    }
    try {
      const zona = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (ZONA_A_REGION[zona]) return ZONA_A_REGION[zona];
      if (zona.indexOf('America/Argentina') === 0) return 'es-AR';
    } catch (e) { /* sin Intl: se usa el de por defecto */ }
    return 'es-ES';
  }

  function normalizarParaComparar(texto) {
    return String(texto || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9ñ\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  // "misericordia" ~ "misericordias", "salvador" ~ "salvadora": mismo
  // tronco, que es lo que el reconocedor suele confundir.
  function palabrasParecidas(a, b) {
    if (a === b) return true;
    const n = Math.min(a.length, b.length);
    if (n < 5 || Math.abs(a.length - b.length) > 2) return false;
    return a.slice(0, n - 1) === b.slice(0, n - 1);
  }

  function puntajeCoincidencia(esperado, dicho) {
    const esperadas = normalizarParaComparar(esperado);
    if (!esperadas.length) return 0;
    const oidas = normalizarParaComparar(dicho);
    const exactas = new Set(oidas);
    let aciertos = 0;
    for (const p of esperadas) {
      if (exactas.has(p) || oidas.some((o) => palabrasParecidas(p, o))) aciertos++;
    }
    return aciertos / esperadas.length;
  }

  function coincideSuficiente(esperado, dicho) {
    return puntajeCoincidencia(esperado, dicho) >= UMBRAL_COINCIDENCIA;
  }

  function crearReconocedor() {
    if (rec.obj) return rec.obj;

    const r = new CtorReconocimiento();
    r.lang = idiomaReconocimiento();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (evento) => {
      const t = rec.turno;
      if (!t || rec.sesionDeTurno !== t.id) return;   // sesión de un turno anterior
      rec.erroresRed = 0;

      // Todo lo oído en ESTA sesión, desde el principio — no solo lo
      // que cambió en este evento (evento.resultIndex).
      let oido = '';
      for (let i = 0; i < evento.results.length; i++) {
        oido += ' ' + evento.results[i][0].transcript;
      }
      rec.textoSesion = oido;

      if (coincideSuficiente(t.texto, t.acumulado + ' ' + oido)) confirmarTurno(t);
    };

    r.onerror = (evento) => {
      if (evento.error === 'not-allowed' || evento.error === 'service-not-allowed' ||
          evento.error === 'audio-capture') {
        desactivarReconocimiento('No pude usar el micrófono (permiso denegado o no disponible). Actívalo en los ajustes del navegador si quieres esta función.');
        return;
      }
      if (evento.error === 'network') {
        // Sin internet, o un navegador que no ofrece el servicio (Brave
        // lo trae apagado). Antes se reintentaba en bucle sin avisar.
        rec.erroresRed++;
        if (rec.erroresRed >= 3) {
          avisarReconocimiento('El reconocimiento de voz no está respondiendo: sin conexión, o este navegador no ofrece el servicio (Brave, por ejemplo, lo trae apagado; en Chrome o Edge sí funciona). Los botones siguen funcionando igual.');
          rec.turno = null;
          if (el.indicadorEscucha) el.indicadorEscucha.hidden = true;
        }
      }
      // 'no-speech' y 'aborted' son normales: onend decide si reinicia.
    };

    r.onend = () => {
      rec.sesionActiva = false;
      rec.ultimoFin = Date.now();
      soltarPista();

      const t = rec.turno;
      if (t && rec.sesionDeTurno === t.id && rec.textoSesion) {
        // Android corta la sesión tras cada frase: lo oído hasta aquí se
        // guarda para que la frase siguiente se sume, no la reemplace.
        t.acumulado += ' ' + rec.textoSesion;
      }
      rec.textoSesion = '';

      if (rec.turno) {
        setTimeout(arrancarSesion, 200);
      } else {
        liberarEsperasMic();
      }
    };

    rec.obj = r;
    return r;
  }

  // Si el usuario eligió un micrófono concreto en Ajustes (por ejemplo,
  // el del computador en vez del de los audífonos Bluetooth), se le pasa
  // al reconocedor. Así los audífonos no pasan a "modo llamada" y el
  // audio no se corta. En navegadores que todavía no aceptan elegir
  // micrófono, se usa el predeterminado, como antes.
  async function pistaMicrofonoElegido() {
    let id = null;
    try { id = localStorage.getItem(CLAVE_MIC); } catch (e) { id = null; }
    if (!id || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
      return stream.getAudioTracks()[0] || null;
    } catch (e) {
      return null;   // ese micrófono ya no está: se usa el predeterminado
    }
  }

  function soltarPista() {
    if (rec.pista) {
      try { rec.pista.stop(); } catch (e) { /* nada */ }
      rec.pista = null;
    }
  }

  async function arrancarSesion() {
    const t = rec.turno;
    if (!t || rec.sesionActiva || rec.arrancando) return;
    rec.arrancando = true;

    const r = crearReconocedor();
    const pista = await pistaMicrofonoElegido();

    // El turno pudo cambiar mientras se abría el micrófono.
    if (rec.turno !== t) {
      if (pista) pista.stop();
      rec.arrancando = false;
      liberarEsperasMic();
      return;
    }

    try {
      if (pista) {
        rec.pista = pista;
        r.start(pista);
      } else {
        r.start();
      }
      rec.sesionActiva = true;
      rec.usadoAlgunaVez = true;
      rec.sesionDeTurno = t.id;
      rec.textoSesion = '';
      rec.reintentos = 0;
    } catch (e) {
      // La sesión anterior todavía se estaba cerrando: se reintenta en
      // un momento, unas pocas veces.
      if (pista) pista.stop();
      rec.pista = null;
      if (rec.reintentos++ < 5) setTimeout(arrancarSesion, 400);
    }
    rec.arrancando = false;
  }

  function confirmarTurno(t) {
    if (rec.turno !== t) return;
    const alConfirmar = t.alConfirmar;
    detenerEscucha();
    alConfirmar();
  }

  function detenerEscucha() {
    rec.turno = null;
    if (el.indicadorEscucha) el.indicadorEscucha.hidden = true;

    if (rec.obj && rec.sesionActiva) {
      // abort() y no stop(): stop() todavía entrega lo último que oyó.
      try { rec.obj.abort(); } catch (e) { /* ya estaba cerrado */ }
    } else {
      liberarEsperasMic();
    }
  }

  function escucharTurno(textoEsperado, alConfirmar) {
    if (!voz.reconocerVoz || !SOPORTA_RECONOCIMIENTO) return;

    rec.turno = { id: ++rec.contador, texto: textoEsperado, alConfirmar: alConfirmar, acumulado: '' };
    rec.reintentos = 0;
    if (el.indicadorEscucha) el.indicadorEscucha.hidden = false;

    if (rec.sesionActiva) {
      // Queda una sesión de otro turno cerrándose: se descarta, y al
      // terminar (onend) se abre la de este turno.
      try { rec.obj.abort(); } catch (e) { /* nada */ }
    } else {
      arrancarSesion();
    }
  }

  // Resuelve cuando el micrófono está cerrado Y ya pasó el rato que los
  // audífonos necesitan para volver al modo normal. Si el micrófono no se
  // usó recién, resuelve al instante.
  function microfonoLibre() {
    return new Promise((resolve) => {
      let hecho = false;
      const terminar = () => { if (!hecho) { hecho = true; resolve(); } };

      const revisar = () => {
        if (rec.sesionActiva || rec.arrancando) {
          rec.esperasMic.push(revisar);
          return;
        }
        const falta = rec.usadoAlgunaVez ? ASENTAR_MIC_MS - (Date.now() - rec.ultimoFin) : 0;
        if (falta > 0) setTimeout(terminar, falta); else terminar();
      };

      revisar();
      // Seguro: si algún navegador nunca avisa que cerró, no se bloquea.
      setTimeout(terminar, 2500);
    });
  }

  function liberarEsperasMic() {
    const esperas = rec.esperasMic.splice(0);
    esperas.forEach((fn) => fn());
  }

  // Para todo lo que va a sonar: primero se asegura de que el micrófono
  // esté cerrado y los audífonos hayan vuelto a su modo normal, y solo
  // entonces arranca — si el usuario sigue en el mismo paso.
  function cuandoMicLibre(fn) {
    if (!rec.usadoAlgunaVez && !rec.sesionActiva) { fn(); return; }
    const pasoAlPedir = estado.pasos[estado.indice];
    microfonoLibre().then(() => {
      if (estado.pasos[estado.indice] !== pasoAlPedir) return;
      fn();
    });
  }

  function avisarReconocimiento(texto) {
    if (!el.notaReconocer) return;
    el.notaReconocer.hidden = false;
    el.notaReconocer.textContent = texto;
  }

  function desactivarReconocimiento(texto) {
    voz.reconocerVoz = false;
    try { localStorage.setItem('rezar_reconocer', 'false'); } catch (e) { /* nada */ }
    if (el.checkReconocer) el.checkReconocer.checked = false;
    avisarReconocimiento(texto);
    detenerEscucha();
  }

  // Pide el permiso de micrófono una sola vez, en un momento explícito
  // (el usuario toca un botón), en vez de que aparezca de sorpresa a
  // mitad de una oración. El permiso en sí lo recuerda el navegador.
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
    filaMic: document.getElementById('fila-mic'),
    selectMic: document.getElementById('select-mic'),
    notaMic: document.getElementById('nota-mic'),
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
    horaActual: null,
    diaPreparado: false
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

    // Primero, el día ya preparado: si el generador nocturno alcanzó a
    // dejar esta hora lista, llega con los pasos y el audio hechos. Es
    // lo que permite compartir la app sin repartir ninguna clave.
    if (window.VozPrevia) {
      const dia = await window.VozPrevia.obtenerDia(fechaISO(estado.fechaSeleccionada), hora.id);
      if (dia) {
        estado.diaPreparado = true;
        voz.ultimoMotor = null;
        await mostrarPasosListos(hora, dia.pasos);
        actualizarTextoEstadoVoz();
        return;
      }
    }
    estado.diaPreparado = false;
    voz.ultimoMotor = null;

    try {
      const html = await L.obtenerHTMLHora(estado.fechaSeleccionada, hora.id);
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
    const pasos = L.prepararPasos(html);
    if (!pasos.length) throw new Error('vacio');
    await mostrarPasosListos(hora, pasos);
  }

  async function mostrarPasosListos(hora, pasos) {
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
      const html = await L.obtenerHTMLHora(estado.fechaSeleccionada, hora.id, numero);
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
    restaurarBotonEscuchar();
    actualizarMetadatosMedios(paso);
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
      // hablarPartes y no hablar(): así la antífona usa el audio ya
      // preparado del día. Antes llamaba directo a hablar(), que solo
      // conoce la voz en vivo o la del sistema, y las antífonas sonaban
      // siempre con la voz robótica aunque el día estuviera preparado.
      hablarPartes(paso, () => {
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
      cuandoMicLibre(() => {
        el.reproductorPieza.play().catch(() => { /* tiene controles: el usuario le da play */ });
      });
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
    if (window.Reproductor && window.Reproductor.estaInterrumpido()) {
      window.Reproductor.reanudar();
      return;
    }
    const paso = estado.pasos[estado.indice];
    if (paso) hablarPartes(paso, () => {});
  });

  // ---------------------------------------------------------------------
  // Audio en pausa sin que lo pidiéramos
  //
  // Audífonos que se desconectan, el Bluetooth que se cae un segundo,
  // otra app que toma el audio, el navegador que no deja sonar sin un
  // toque... Antes la app se quedaba muda y colgada sin decir nada. Ahora
  // el audio queda en pausa en el punto exacto, la pantalla lo dice, y el
  // botón 🔊 pasa a ▶ para seguir desde ahí.
  // ---------------------------------------------------------------------

  let estadoAntesDePausa = null;

  function restaurarBotonEscuchar() {
    el.btnEscuchar.textContent = '🔊';
    el.btnEscuchar.title = 'Repetir en voz alta';
    el.btnEscuchar.classList.remove('es-reanudar');
    estadoAntesDePausa = null;
  }

  window.addEventListener('rezar-audio-interrumpido', (e) => {
    if (el.oracion.hidden) return;
    const motivo = e.detail && e.detail.motivo;
    if (estadoAntesDePausa === null) {
      estadoAntesDePausa = {
        texto: el.estado.textContent,
        turno: el.estado.classList.contains('es-turno')
      };
    }
    el.estado.textContent = motivo === 'bloqueado'
      ? 'Toca ▶ para empezar a escuchar.'
      : 'En pausa (¿se desconectaron los audífonos?). Toca ▶ para seguir.';
    el.estado.classList.add('es-turno');
    el.btnEscuchar.hidden = false;
    el.btnEscuchar.textContent = '▶';
    el.btnEscuchar.title = 'Seguir escuchando';
    el.btnEscuchar.classList.add('es-reanudar');
  });

  window.addEventListener('rezar-audio-reanudado', () => {
    const antes = estadoAntesDePausa;
    restaurarBotonEscuchar();
    if (antes) {
      el.estado.textContent = antes.texto;
      el.estado.classList.toggle('es-turno', antes.turno);
    }
  });

  // ---------------------------------------------------------------------
  // Botones de los audífonos y de la pantalla bloqueada
  //
  // Con esto, el botón de play/pausa de los audífonos pausa y sigue la
  // oración, y los de siguiente/anterior avanzan o retroceden un paso.
  // En el celular también aparecen los controles en la pantalla
  // bloqueada.
  // ---------------------------------------------------------------------

  function configurarSesionMedios() {
    if (!('mediaSession' in navigator)) return;
    const poner = (accion, fn) => {
      try { navigator.mediaSession.setActionHandler(accion, fn); } catch (e) { /* acción no soportada */ }
    };
    poner('play', () => {
      if (window.Reproductor && window.Reproductor.estaInterrumpido()) {
        window.Reproductor.reanudar();
      } else if (!el.oracion.hidden) {
        const paso = estado.pasos[estado.indice];
        if (paso) hablarPartes(paso, () => {});
      }
    });
    poner('pause', () => { if (window.Reproductor) window.Reproductor.pausar(); });
    poner('nexttrack', () => { if (!el.oracion.hidden) el.btnContinuar.click(); });
    poner('previoustrack', () => { if (!el.oracion.hidden) retroceder(); });
  }

  function actualizarMetadatosMedios(paso) {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: estado.horaActual ? estado.horaActual.nombre : 'Modo Rezar',
        artist: paso ? paso.etiqueta : '',
        album: 'Modo Rezar',
        artwork: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    } catch (e) { /* nada */ }
  }

  configurarSesionMedios();

  // El primer toque del usuario "desbloquea" el reproductor: después el
  // navegador deja sonar sin pedir más toques (el iPhone lo exige).
  function desbloquearAudio() {
    if (window.Reproductor) window.Reproductor.desbloquear();
  }
  el.btnContinuar.addEventListener('click', desbloquearAudio);
  el.btnEscuchar.addEventListener('click', desbloquearAudio);
  el.listaHoras.addEventListener('click', desbloquearAudio, true);
  el.listaOpciones.addEventListener('click', desbloquearAudio, true);

  // ---------------------------------------------------------------------
  // Voz de Fish Audio: estado visible y clave de API
  //
  // La clave no está —ni puede estar— dentro de los archivos de la app:
  // esto es un sitio estático y público, cualquiera podría leerla. Se
  // escribe una sola vez aquí y se guarda únicamente en este dispositivo
  // (localStorage). Nunca se muestra entera de vuelta, nunca se imprime
  // en consola y nunca sale hacia otro sitio que no sea api.fish.audio.
  // ---------------------------------------------------------------------

  // Qué voz está sonando de verdad. Lo principal es el audio preparado del
  // día (voz local, sin clave, igual para todos); la voz en vivo con Fish
  // Audio es una opción avanzada para quien tenga su propia clave.
  function actualizarTextoEstadoVoz(detalle) {
    if (!el.estadoVoz) return;

    const tieneFish = !!(window.VozFish && window.VozFish.tieneClave());

    if (voz.ultimoMotor === 'pregenerado' || (estado.diaPreparado && voz.ultimoMotor !== 'sistema')) {
      el.estadoVoz.textContent = 'Voz: preparada para este día — la misma para todos.';
      return;
    }

    if (voz.ultimoMotor === 'sistema') {
      el.estadoVoz.textContent = estado.diaPreparado
        ? 'Voz: una parte no estaba preparada y se leyó con la voz del sistema del dispositivo.'
        : 'Voz: esta hora de este día todavía no está preparada, así que se lee con la voz del sistema del dispositivo. Cada madrugada se preparan hoy y los dos días siguientes.';
      if (tieneFish) el.estadoVoz.textContent += ' Fish Audio no pudo leerlo: ' + textoEstadoFish(detalle);
      return;
    }

    if (tieneFish) {
      el.estadoVoz.textContent = 'Voz en vivo con Fish Audio: ' + textoEstadoFish(detalle);
      return;
    }

    el.estadoVoz.textContent = estado.diaPreparado
      ? 'Voz: preparada para este día.'
      : 'Voz: esta hora de este día todavía no está preparada, así que se leerá con la voz del sistema del dispositivo. Cada madrugada se preparan hoy y los dos días siguientes.';
  }

  function textoEstadoFish(detalle) {
    if (!window.VozFish) return 'no se pudo cargar.';
    const d = detalle || window.VozFish.obtenerEstado();
    switch (d.fase) {
      case 'lista': return 'activa.';
      case 'sin-clave': return 'falta la clave.';
      case 'error-clave': return 'rechazó la clave; revísala.';
      case 'error-cuota': return 'la cuenta no tiene saldo o cuota.';
      case 'error-voz': return window.VozFish.MSG_VOZ_NO_DISPONIBLE;
      case 'error-red': return 'sin conexión, o el navegador bloqueó la petición.';
      case 'error-api': return 'devolvió un error (' + (d.error || 'desconocido') + ').';
      default: return 'en espera.';
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
    if (!el.panelConfig.hidden) actualizarTextoEstadoVoz();
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

  // ---------------------------------------------------------------------
  // Elegir el micrófono para el reconocimiento
  //
  // Cuando una página usa el micrófono de unos audífonos Bluetooth, el
  // sistema los pasa a "modo llamada": en Windows la salida estéreo se
  // queda muda, y en el celular el sonido baja de calidad o se va por el
  // altavoz. Usar el micrófono del computador o del celular evita eso por
  // completo, y los audífonos siguen sonando normal.
  // ---------------------------------------------------------------------

  const RE_MIC_AUDIFONOS = /hands-?free|manos libres|headset|auricular|aud[ií]fono|bluetooth|airpods|buds|wh-|wf-|jabra|bose/i;

  async function llenarListaMicrofonos() {
    if (!el.selectMic || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    let dispositivos = [];
    try { dispositivos = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }

    const entradas = dispositivos.filter((d) =>
      d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const porDefecto = dispositivos.find((d) => d.kind === 'audioinput' && d.deviceId === 'default');

    let elegido = '';
    try { elegido = localStorage.getItem(CLAVE_MIC) || ''; } catch (e) { elegido = ''; }

    el.selectMic.innerHTML = '';
    el.selectMic.add(new Option('El predeterminado del sistema', ''));
    entradas.forEach((d, i) => {
      el.selectMic.add(new Option(d.label || ('Micrófono ' + (i + 1)), d.deviceId));
    });
    el.selectMic.value = entradas.some((d) => d.deviceId === elegido) ? elegido : '';

    // Sin permiso concedido, el navegador no da los nombres.
    const sinNombres = entradas.length > 0 && entradas.every((d) => !d.label);
    // Si el predeterminado parece ser el de unos audífonos y no se ha
    // elegido otro, se resalta el consejo.
    const predeterminadoEsAudifono = !elegido && porDefecto && RE_MIC_AUDIFONOS.test(porDefecto.label || '');

    if (el.notaMic) {
      el.notaMic.classList.toggle('nota-importante', !!predeterminadoEsAudifono);
      if (sinNombres) {
        el.notaMic.textContent = 'Toca "Activar micrófono ahora" para ver los nombres de los micrófonos. Con audífonos Bluetooth conviene elegir el del computador o del celular.';
      } else if (predeterminadoEsAudifono) {
        el.notaMic.textContent = 'Tu micrófono predeterminado es el de los audífonos. Eso los pasa a "modo llamada" y puede dejarlos sin sonido: elige aquí el micrófono del computador o del celular.';
      } else {
        el.notaMic.textContent = 'Con audífonos Bluetooth, elige aquí el micrófono del computador o del celular: así los audífonos no pasan a "modo llamada" y el audio no se corta.';
      }
    }
  }

  if (el.filaMic) {
    const puedeElegir = SOPORTA_RECONOCIMIENTO && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices;
    el.filaMic.hidden = !puedeElegir;

    if (puedeElegir) {
      el.selectMic.addEventListener('change', () => {
        try {
          if (el.selectMic.value) localStorage.setItem(CLAVE_MIC, el.selectMic.value);
          else localStorage.removeItem(CLAVE_MIC);
        } catch (e) { /* nada */ }
        llenarListaMicrofonos();
      });
      el.btnConfig.addEventListener('click', () => { if (!el.panelConfig.hidden) llenarListaMicrofonos(); });
      if (el.btnActivarMic) el.btnActivarMic.addEventListener('click', () => setTimeout(llenarListaMicrofonos, 800));
      try { navigator.mediaDevices.addEventListener('devicechange', llenarListaMicrofonos); } catch (e) { /* nada */ }
      llenarListaMicrofonos();
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
