// Cómo se le pide audio a Fish Audio — en un solo sitio.
//
// Este archivo lo usan los DOS caminos que generan voz:
//   - voz-fish.js, en el navegador, cuando alguien pone su propia clave.
//   - herramientas/generar-dia.js, de madrugada, para dejar el día listo.
//
// Está aparte justo para que no se separen: si un lado pidiera el audio
// con parámetros distintos del otro, la misma frase sonaría diferente
// según quién la generó, y eso es casi imposible de depurar después.
//
// Reglas fijas (no cambiar sin instrucción explícita del usuario):
//   - Siempre reference_id = 8d2c17a9b26d4d83888ea67a1ee565b2
//   - Nunca se sustituye por otra voz, ni la de por defecto, ni una
//     "parecida", ni se clona una nueva.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    raiz.VozComun = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API_URL = 'https://api.fish.audio/v1/tts';
  const VOICE_ID = '8d2c17a9b26d4d83888ea67a1ee565b2';
  const MODEL = 's2.1-pro-free';
  const FORMAT = 'mp3';

  const MSG_VOZ_NO_DISPONIBLE =
    'La voz ' + VOICE_ID + ' no está disponible para esta llamada.';

  function normalizarVelocidad(velocidad) {
    const v = Number(velocidad);
    if (!v || v <= 0) return 1;
    // Fish Audio acepta de 0.5 a 2.0; se redondea a dos decimales para
    // que la caché no se llene de variantes casi idénticas.
    return Math.round(Math.min(2, Math.max(0.5, v)) * 100) / 100;
  }

  function cuerpoPeticion(texto, velocidad) {
    return {
      text: texto,
      reference_id: VOICE_ID,
      format: FORMAT,

      // Esto es lo que hace que un párrafo suene a párrafo y no a frases
      // sueltas pegadas. El modelo parte el texto en trozos internos de
      // hasta 300 caracteres, pero con condition_on_previous_chunks usa
      // el audio ya generado como contexto del siguiente, así que la
      // entonación sigue de corrido a lo largo de todo el bloque. Solo
      // funciona dentro de UNA llamada: por eso se le manda el párrafo
      // entero de una vez y no frase por frase.
      chunk_length: 300,
      condition_on_previous_chunks: true,

      // 'normal' es la mejor calidad; las otras opciones bajan latencia
      // a costa de calidad.
      latency: 'normal',
      normalize: true,

      // La velocidad la genera el modelo, no se fuerza después
      // acelerando el audio: así no suena a cinta mal puesta.
      prosody: { speed: normalizarVelocidad(velocidad) }
    };
  }

  function cabeceras(apiKey) {
    return {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'model': MODEL
    };
  }

  // Traduce una respuesta de error de la API a algo que se le pueda
  // decir a una persona. `detalle` es el cuerpo de la respuesta; NUNCA
  // se le pasan las cabeceras, que es donde va la clave.
  function clasificarError(estado, detalle) {
    detalle = String(detalle || '');

    if (estado === 401 || estado === 403) {
      return { clase: 'clave', mensaje: 'Fish Audio rechazó la clave de API.' };
    }
    if (estado === 402) {
      return { clase: 'cuota', mensaje: 'La cuenta de Fish Audio no tiene saldo o cuota disponible.' };
    }
    if (estado === 429) {
      return { clase: 'ritmo', mensaje: 'Demasiadas peticiones a la vez; hay que esperar un momento.' };
    }
    // Error referido a la voz: se informa tal cual, conservando el ID
    // original, sin sustituirla por ninguna otra.
    if (estado === 404 || /reference|voice|model/i.test(detalle)) {
      return { clase: 'voz', mensaje: MSG_VOZ_NO_DISPONIBLE };
    }
    if (estado >= 500) {
      return { clase: 'servidor', mensaje: 'Fish Audio tuvo un error interno (' + estado + ').' };
    }
    return { clase: 'api', mensaje: 'Fish Audio respondió con un error ' + estado + '.' };
  }

  return {
    API_URL, VOICE_ID, MODEL, FORMAT, MSG_VOZ_NO_DISPONIBLE,
    normalizarVelocidad, cuerpoPeticion, cabeceras, clasificarError
  };
});
