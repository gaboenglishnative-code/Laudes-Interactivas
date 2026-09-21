// Voz principal de Modo Rezar: Fish Audio (API alojada).
//
// El texto sale de aquí hacia la API de Fish Audio junto con el
// reference_id de la voz elegida; Fish Audio devuelve el audio ya
// generado en MP3 y la app lo reproduce. El modelo NO corre en este
// dispositivo: no se descarga ningún checkpoint ni se instala nada.
//
// Reglas fijas (no cambiar sin instrucción explícita del usuario):
//   - Siempre se usa reference_id = 8d2c17a9b26d4d83888ea67a1ee565b2
//   - Nunca se sustituye por otra voz de Fish Audio, ni por la de por
//     defecto, ni se clona una voz nueva.
//   - Si Fish Audio responde que esa voz no está disponible, se informa
//     tal cual, conservando el ID original para diagnóstico.
//
// La clave de API NO vive en este archivo ni en ningún archivo del
// repositorio: la escribe el usuario una sola vez en Ajustes y se guarda
// únicamente en su propio dispositivo (localStorage). Nunca se imprime
// en consola, nunca se envía a ningún sitio que no sea api.fish.audio.

(function () {
  'use strict';

  const API_URL = 'https://api.fish.audio/v1/tts';
  const VOICE_ID = '8d2c17a9b26d4d83888ea67a1ee565b2';
  const MODEL = 's2.1-pro-free';
  const FORMAT = 'mp3';

  const CLAVE_LS = 'rezar_fish_key';

  // Mensaje exacto pedido para el caso de voz no disponible.
  const MSG_VOZ_NO_DISPONIBLE =
    'La voz ' + VOICE_ID + ' no está disponible para esta llamada.';

  // -------------------------------------------------------------------
  // Estado visible (Ajustes lo muestra; app.js escucha 'vozfish-estado')
  // -------------------------------------------------------------------

  let estadoActual = { fase: 'sin-clave', error: null };

  function actualizarEstado(fase, error) {
    const mensaje = error ? String((error && error.message) || error) : null;
    estadoActual = { fase, error: mensaje };
    try {
      window.dispatchEvent(new CustomEvent('vozfish-estado', { detail: estadoActual }));
    } catch (e) {
      // Entorno sin CustomEvent: no es crítico.
    }
  }

  function obtenerEstado() {
    return estadoActual;
  }

  // -------------------------------------------------------------------
  // Clave de API: solo en este dispositivo
  // -------------------------------------------------------------------

  function obtenerClave() {
    try {
      const k = localStorage.getItem(CLAVE_LS);
      return k && k.trim() ? k.trim() : null;
    } catch (e) {
      return null;
    }
  }

  function guardarClave(clave) {
    const limpia = String(clave || '').trim();
    if (!limpia) return false;
    try {
      localStorage.setItem(CLAVE_LS, limpia);
    } catch (e) {
      return false;
    }
    actualizarEstado('lista');
    return true;
  }

  function borrarClave() {
    try { localStorage.removeItem(CLAVE_LS); } catch (e) { /* nada */ }
    actualizarEstado('sin-clave');
  }

  function tieneClave() {
    return !!obtenerClave();
  }

  // -------------------------------------------------------------------
  // Caché en el dispositivo: cada frase generada se guarda para no
  // volver a pedirla nunca. Importa mucho aquí: el salterio rota cada 4
  // semanas y frases como "Gloria al Padre..." o "Amén" se repiten
  // decenas de veces al día. Así la segunda vez suena al instante y no
  // consume cuota de la API.
  // -------------------------------------------------------------------

  const DB_NOMBRE = 'modo-rezar-voz';
  const ALMACEN = 'frases';
  const MAX_ENTRADAS = 600;

  let promesaDB = null;

  function abrirDB() {
    if (promesaDB) return promesaDB;
    promesaDB = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('sin-indexeddb')); return; }
      const peticion = indexedDB.open(DB_NOMBRE, 1);
      peticion.onupgradeneeded = () => {
        const db = peticion.result;
        if (!db.objectStoreNames.contains(ALMACEN)) {
          const almacen = db.createObjectStore(ALMACEN, { keyPath: 'clave' });
          almacen.createIndex('usado', 'usado');
        }
      };
      peticion.onsuccess = () => resolve(peticion.result);
      peticion.onerror = () => reject(peticion.error);
    }).catch((err) => {
      promesaDB = null;
      throw err;
    });
    return promesaDB;
  }

  function normalizarVelocidad(velocidad) {
    const v = Number(velocidad);
    if (!v || v <= 0) return 1;
    // Fish Audio acepta de 0.5 a 2.0; se redondea a dos decimales para
    // que la caché no se llene de variantes casi idénticas.
    return Math.round(Math.min(2, Math.max(0.5, v)) * 100) / 100;
  }

  function claveDeTexto(texto, velocidad) {
    // El propio texto es la clave, con la voz y la velocidad delante: si
    // algún día se cambia de voz por instrucción explícita, la caché
    // vieja deja de usarse sola en vez de sonar con la voz anterior.
    return VOICE_ID + '@' + normalizarVelocidad(velocidad) + '::' + texto;
  }

  async function leerDeCache(texto, velocidad) {
    try {
      const db = await abrirDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(ALMACEN, 'readonly');
        const p = tx.objectStore(ALMACEN).get(claveDeTexto(texto, velocidad));
        p.onsuccess = () => resolve(p.result && p.result.blob ? p.result.blob : null);
        p.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function guardarEnCache(texto, velocidad, blob) {
    try {
      const db = await abrirDB();
      await new Promise((resolve) => {
        const tx = db.transaction(ALMACEN, 'readwrite');
        tx.objectStore(ALMACEN).put({
          clave: claveDeTexto(texto, velocidad),
          blob: blob,
          usado: Date.now()
        });
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
      podarCache();
    } catch (e) {
      // Sin caché disponible la app funciona igual, solo más lenta.
    }
  }

  let podando = false;

  async function podarCache() {
    if (podando) return;
    podando = true;
    try {
      const db = await abrirDB();
      const total = await new Promise((resolve) => {
        const tx = db.transaction(ALMACEN, 'readonly');
        const p = tx.objectStore(ALMACEN).count();
        p.onsuccess = () => resolve(p.result || 0);
        p.onerror = () => resolve(0);
      });
      if (total <= MAX_ENTRADAS) return;

      let porBorrar = total - MAX_ENTRADAS;
      await new Promise((resolve) => {
        const tx = db.transaction(ALMACEN, 'readwrite');
        const indice = tx.objectStore(ALMACEN).index('usado');
        const cursor = indice.openCursor(); // del más viejo al más nuevo
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || porBorrar <= 0) { resolve(); return; }
          c.delete();
          porBorrar--;
          c.continue();
        };
        cursor.onerror = () => resolve();
        tx.oncomplete = resolve;
      });
    } catch (e) {
      // No pasa nada: la caché simplemente crece un poco más.
    } finally {
      podando = false;
    }
  }

  async function limpiarCache() {
    try {
      const db = await abrirDB();
      await new Promise((resolve) => {
        const tx = db.transaction(ALMACEN, 'readwrite');
        tx.objectStore(ALMACEN).clear();
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch (e) { /* nada */ }
  }

  // -------------------------------------------------------------------
  // Llamada a la API
  // -------------------------------------------------------------------

  function errorDeVoz() {
    const err = new Error(MSG_VOZ_NO_DISPONIBLE);
    err.vozNoDisponible = true;
    err.referenceId = VOICE_ID; // se conserva el ID original para diagnóstico
    return err;
  }

  async function pedirAFishAudio(texto, velocidad) {
    const apiKey = obtenerClave();
    if (!apiKey) {
      actualizarEstado('sin-clave');
      throw new Error('sin-clave');
    }

    let respuesta;
    try {
      respuesta = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'model': MODEL
        },
        body: JSON.stringify({
          text: texto,
          reference_id: VOICE_ID,
          format: FORMAT,

          // Esto es lo que hace que un párrafo suene a párrafo y no a
          // frases sueltas pegadas. El modelo parte el texto en trozos
          // internos de hasta 300 caracteres, pero con
          // condition_on_previous_chunks usa el audio ya generado como
          // contexto del siguiente, así que la entonación sigue de
          // corrido a lo largo de todo el bloque. Solo funciona dentro
          // de UNA llamada: por eso hay que mandarle el párrafo entero
          // de una vez y no frase por frase.
          chunk_length: 300,
          condition_on_previous_chunks: true,

          // 'normal' es la mejor calidad (las otras opciones bajan
          // latencia a costa de calidad).
          latency: 'normal',
          normalize: true,

          // La velocidad la genera el modelo, no se fuerza después
          // acelerando el audio: así no suena a cinta mal puesta.
          prosody: { speed: normalizarVelocidad(velocidad) }
        })
      });
    } catch (err) {
      // Sin red, o el navegador bloqueó la petición (CORS).
      const e = new Error('No pude contactar a Fish Audio desde el navegador (sin conexión o bloqueado por el navegador).');
      e.causaRed = true;
      actualizarEstado('error-red', e);
      throw e;
    }

    if (!respuesta.ok) {
      // El cuerpo de error de Fish Audio es JSON; se lee solo para saber
      // el motivo. NUNCA se registra ninguna cabecera (ahí va la clave).
      let detalle = '';
      try { detalle = (await respuesta.text()).slice(0, 300); } catch (e) { /* nada */ }

      if (respuesta.status === 401 || respuesta.status === 403) {
        const e = new Error('Fish Audio rechazó la clave de API (revísala en Ajustes).');
        e.claveInvalida = true;
        actualizarEstado('error-clave', e);
        throw e;
      }

      if (respuesta.status === 402) {
        const e = new Error('La cuenta de Fish Audio no tiene saldo o cuota disponible.');
        actualizarEstado('error-cuota', e);
        throw e;
      }

      // Error referido a la voz: se informa tal cual, sin sustituirla
      // por ninguna otra y sin elegir una "parecida".
      if (respuesta.status === 404 || /reference|voice|model/i.test(detalle)) {
        const e = errorDeVoz();
        actualizarEstado('error-voz', e);
        throw e;
      }

      const e = new Error('Fish Audio respondió con un error ' + respuesta.status + '.');
      actualizarEstado('error-api', e);
      throw e;
    }

    const blob = await respuesta.blob();
    if (!blob || !blob.size) {
      const e = new Error('Fish Audio devolvió un audio vacío.');
      actualizarEstado('error-api', e);
      throw e;
    }

    actualizarEstado('lista');
    return blob;
  }

  // Una misma frase pedida dos veces a la vez (por ejemplo, la que se
  // está precalentando y la que toca reproducir) comparte una sola
  // llamada a la API.
  const enVuelo = new Map();

  async function generar(texto, velocidad) {
    const limpio = String(texto || '').trim();
    if (!limpio) throw new Error('texto-vacio');

    const vel = normalizarVelocidad(velocidad);
    const idPeticion = vel + '::' + limpio;

    const cacheado = await leerDeCache(limpio, vel);
    if (cacheado) return cacheado;

    if (enVuelo.has(idPeticion)) return enVuelo.get(idPeticion);

    const promesa = pedirAFishAudio(limpio, vel)
      .then(async (blob) => {
        await guardarEnCache(limpio, vel, blob);
        return blob;
      })
      .finally(() => { enVuelo.delete(idPeticion); });

    enVuelo.set(idPeticion, promesa);
    return promesa;
  }

  // Pide y guarda en caché un bloque sin reproducirlo, para que cuando
  // llegue su turno empiece al instante. Es lo que evita el silencio
  // entre un paso y el siguiente.
  function precalentar(texto, velocidad) {
    if (!texto || !tieneClave()) return;
    generar(texto, velocidad).catch(() => { /* se reintentará al reproducirlo */ });
  }

  // -------------------------------------------------------------------
  // Reproducción
  // -------------------------------------------------------------------

  let audioEl = null;
  let urlObjetoActual = null;
  let generacion = 0;

  function obtenerAudioEl() {
    if (!audioEl) {
      audioEl = document.getElementById('reproductor-voz') || new Audio();
    }
    return audioEl;
  }

  function detener() {
    generacion++;
    const el = obtenerAudioEl();
    try { el.pause(); } catch (e) { /* nada */ }
    el.onended = null;
    el.onerror = null;
    if (urlObjetoActual) {
      URL.revokeObjectURL(urlObjetoActual);
      urlObjetoActual = null;
    }
  }

  async function hablar(texto, opciones) {
    opciones = opciones || {};
    detener();
    const miGeneracion = generacion;

    const blob = await generar(texto, opciones.velocidad);

    // Si mientras se generaba el usuario avanzó, saltó o salió, este
    // audio ya no debe sonar.
    if (miGeneracion !== generacion) return;

    urlObjetoActual = URL.createObjectURL(blob);
    const el = obtenerAudioEl();
    el.src = urlObjetoActual;

    // playbackRate se queda en 1 a propósito: acelerar o frenar el audio
    // ya generado lo hace sonar artificial. La velocidad se le pidió al
    // modelo en prosody.speed, que la genera bien de entrada.
    el.playbackRate = 1;

    if (opciones.alEmpezar) {
      try { opciones.alEmpezar(); } catch (e) { /* nada */ }
    }

    return new Promise((resolve) => {
      el.onended = resolve;
      el.onerror = resolve;
      el.play().catch(resolve);
    });
  }

  // -------------------------------------------------------------------

  if (tieneClave()) {
    actualizarEstado('lista');
  } else {
    actualizarEstado('sin-clave');
  }

  window.VozFish = {
    hablar,
    precalentar,
    detener,
    obtenerEstado,
    tieneClave,
    guardarClave,
    borrarClave,
    limpiarCache,
    VOICE_ID,
    MODEL,
    MSG_VOZ_NO_DISPONIBLE
  };
})();
