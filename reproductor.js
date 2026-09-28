// Reproductor único de la voz de Modo Rezar.
//
// Todo lo que la app dice en voz alta con un mp3 (audio pregenerado del
// día o generado al vuelo) pasa por aquí. Existe para arreglar un fallo
// concreto: "con audífonos a veces no suena nada".
//
// Lo que pasaba antes:
//   - Si el navegador pausaba el audio por su cuenta (se desconectan los
//     audífonos, se cae el Bluetooth un segundo, entra una notificación
//     o una llamada), el audio nunca llegaba a "terminar", así que la app
//     se quedaba esperando para siempre, muda, sin decir por qué.
//   - Si play() fallaba (el navegador bloqueó la reproducción, o la
//     salida de audio estaba cambiando justo en ese momento), en un sitio
//     se daba por terminado y la app saltaba el texto sin leerlo, y en
//     otro se pasaba a la voz robótica del sistema.
//
// Ahora, en cualquiera de esos casos, el audio queda EN PAUSA — no se
// pierde ni se salta nada — y la app avisa en pantalla para que se pueda
// seguir con un toque (o con el botón de los audífonos).

(function () {
  'use strict';

  let el = null;
  let actual = null;   // la reproducción en curso: { src, resolve, reject, interrumpido }
  let enlazado = false;

  // Un wav de silencio de unos milisegundos, para "desbloquear" el
  // reproductor con el primer toque del usuario (iPhone lo exige).
  const SILENCIO =
    'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

  function avisar(nombre, detalle) {
    try { window.dispatchEvent(new CustomEvent(nombre, { detail: detalle || {} })); }
    catch (e) { /* entorno sin CustomEvent: no es crítico */ }
  }

  function elemento() {
    if (el) return el;
    el = document.getElementById('reproductor-voz') || new Audio();
    enlazar();
    return el;
  }

  function mismoAudio() {
    return actual && el && el.src === actual.src;
  }

  function enlazar() {
    if (enlazado) return;
    enlazado = true;

    el.addEventListener('ended', () => {
      if (!mismoAudio()) return;
      const a = actual;
      actual = null;
      a.resolve();
    });

    // Error real de carga (archivo que no existe o formato roto): quien
    // llamó decide qué hacer (por ejemplo, leerlo con otra voz).
    el.addEventListener('error', () => {
      if (!mismoAudio()) return;
      const a = actual;
      actual = null;
      a.reject(new Error('no-se-pudo-cargar'));
    });

    // Una pausa que NO pedimos nosotros: audífonos desconectados, otra
    // app que tomó el audio, el botón de pausa de los audífonos... El
    // audio queda en pausa y se avisa; nada se da por terminado.
    el.addEventListener('pause', () => {
      if (!mismoAudio()) return;       // pausa de un audio que ya no es el actual
      if (el.ended) return;            // el navegador pausa justo antes de 'ended'
      if (!el.paused) return;          // evento viejo: ya se volvió a dar play
      marcarInterrumpido('pausa');
    });

    el.addEventListener('playing', () => {
      if (!mismoAudio() || !actual.interrumpido) return;
      actual.interrumpido = false;
      avisar('rezar-audio-reanudado');
      actualizarSesionMedios('playing');
    });
  }

  function marcarInterrumpido(motivo) {
    if (!actual || actual.interrumpido) return;
    actual.interrumpido = true;
    avisar('rezar-audio-interrumpido', { motivo: motivo });
    actualizarSesionMedios('paused');
  }

  function actualizarSesionMedios(estado) {
    try {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = estado;
    } catch (e) { /* nada */ }
  }

  // Reproduce un audio y resuelve cuando TERMINA de verdad. Rechaza solo
  // si el archivo no se puede cargar. Si el navegador lo pausa o no deja
  // arrancarlo, la promesa sigue pendiente hasta que se reanude.
  function reproducir(src, opciones) {
    opciones = opciones || {};
    detener();

    const a = elemento();
    a.src = src;

    const velocidad = Number(opciones.velocidad);
    a.playbackRate = (velocidad && velocidad > 0) ? velocidad : 1;

    return new Promise((resolve, reject) => {
      actual = { src: a.src, resolve: resolve, reject: reject, interrumpido: false };
      const esta = actual;

      a.play().then(() => {
        if (actual !== esta) return;
        actualizarSesionMedios('playing');
        if (opciones.alEmpezar) {
          try { opciones.alEmpezar(); } catch (e) { /* nada */ }
        }
      }).catch((err) => {
        if (actual !== esta) return;
        // AbortError: lo interrumpimos nosotros al pasar a otro audio.
        if (err && err.name === 'AbortError') return;
        // NotAllowedError: el navegador no deja sonar sin un toque. No
        // es un fallo del audio: se espera a que el usuario toque ▶.
        if (err && err.name === 'NotAllowedError') {
          marcarInterrumpido('bloqueado');
          return;
        }
        actual = null;
        reject(err || new Error('no-se-pudo-reproducir'));
      });
    });
  }

  // Parar porque la app pasa a otra cosa (siguiente paso, salir...). La
  // promesa del audio anterior se abandona a propósito: quien la esperaba
  // ya no está en pantalla.
  function detener() {
    actual = null;
    if (!el) return;
    try { el.pause(); } catch (e) { /* nada */ }
    actualizarSesionMedios('none');
  }

  // Pausa pedida por el usuario (botón de pausa de los audífonos o de la
  // pantalla bloqueada): igual que una pausa externa, se puede reanudar.
  function pausar() {
    if (!actual || !el) return;
    try { el.pause(); } catch (e) { /* nada */ }
  }

  // Se llama desde un toque del usuario, así que el navegador sí deja
  // sonar.
  function reanudar() {
    if (!actual || !el) return false;
    const p = el.play();
    if (p && p.catch) p.catch(() => marcarInterrumpido('bloqueado'));
    return true;
  }

  function estaInterrumpido() {
    return !!(actual && actual.interrumpido);
  }

  function estaSonando() {
    return !!(actual && !actual.interrumpido);
  }

  // Con el primer toque del usuario, se hace sonar un instante de
  // silencio: desde entonces el navegador deja reproducir sin más toques
  // (Safari en iPhone lo necesita; en los demás no estorba).
  let desbloqueado = false;
  function desbloquear() {
    if (desbloqueado || actual) return;
    desbloqueado = true;
    const a = elemento();
    try {
      a.src = SILENCIO;
      const p = a.play();
      if (p && p.then) p.then(() => { if (!actual) a.pause(); }).catch(() => { desbloqueado = false; });
    } catch (e) { desbloqueado = false; }
  }

  window.Reproductor = {
    reproducir, detener, pausar, reanudar, estaInterrumpido, estaSonando, desbloquear
  };
})();
