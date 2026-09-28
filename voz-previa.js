// Voz pregenerada: reproduce los mp3 que el generador nocturno ya dejó
// listos para el día (ver herramientas/generar-dia.js y el workflow
// .github/workflows/voz-diaria.yml).
//
// Esto es lo que hace que la app se pueda compartir con otras personas
// sin repartir ninguna clave de API: la Liturgia de las Horas de un día
// es idéntica para todo el mundo, así que el audio se genera UNA vez, de
// madrugada, y todos descargan los mismos archivos estáticos. Nadie
// necesita clave, nadie paga por su cuenta, y suena al instante porque
// no hay que generar nada en el momento.

(function () {
  'use strict';

  const CARPETA_DIAS = 'dias';

  // Busca el día ya preparado. Devuelve null si no existe (día que el
  // generador todavía no alcanzó, o fecha vieja fuera de la ventana):
  // ahí la app sigue con su camino normal, leyendo la fuente y usando la
  // voz que tenga disponible.
  async function obtenerDia(fechaISO, horaId) {
    try {
      const resp = await fetch(CARPETA_DIAS + '/' + fechaISO + '/' + horaId + '.json', {
        cache: 'no-cache'
      });
      if (!resp.ok) return null;

      const dia = await resp.json();
      if (!dia || !Array.isArray(dia.pasos) || !dia.pasos.length) return null;
      return dia;
    } catch (e) {
      return null;
    }
  }

  function detener() {
    if (window.Reproductor) window.Reproductor.detener();
  }

  // Le pide al navegador que se vaya trayendo un mp3 que todavía no toca,
  // para que cuando llegue su turno empiece sin espera.
  function precalentar(url) {
    if (!url) return;
    try { fetch(url, { cache: 'force-cache' }).catch(() => {}); } catch (e) { /* nada */ }
  }

  // Reproduce un mp3 ya preparado. Resuelve al terminar; si el archivo
  // falta o está roto, rechaza para que la app lo lea con otra voz. Las
  // pausas externas (audífonos que se desconectan, etc.) las maneja el
  // Reproductor: el audio queda en pausa, no se salta.
  function hablar(url, opciones) {
    return window.Reproductor.reproducir(url, opciones);
  }

  window.VozPrevia = { obtenerDia, hablar, precalentar, detener, CARPETA_DIAS };
})();
