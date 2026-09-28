// Prueba de los dos arreglos de audio y reconocimiento.
//
// Arranca la app entera en un navegador simulado con:
//   - un reconocedor de voz falso que se comporta como el de Chrome
//     (resultados que llegan por partes, sesiones que se cortan como en
//     Android, errores de red como en Brave), y
//   - un reproductor de audio falso al que se le puede "desconectar los
//     audífonos" o bloquear la reproducción.
//
// Para cada caso de reconocimiento se compara también contra la lógica
// ANTERIOR, para demostrar que lo que falla antes, ahora funciona.
//
// Uso:
//   npm install jsdom
//   TZ=America/Bogota node herramientas/prueba-audio.js <carpeta-del-sitio-generado>

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const RAIZ = path.resolve(__dirname, '..');
const SITIO = process.argv[2];
if (!SITIO) { console.error('Falta la carpeta del sitio generado.'); process.exit(2); }

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
function comprobar(nombre, ok, detalle) {
  console.log((ok ? '  OK    ' : '  FALLA ') + nombre + (detalle ? '  — ' + detalle : ''));
  if (!ok) fallos++;
}

// -------------------------------------------------------------------
// La lógica ANTERIOR de reconocimiento, tal cual estaba, para comparar.
// -------------------------------------------------------------------
function normViejo(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function coincideViejo(esperado, dicho) {
  const e = normViejo(esperado); const d = new Set(normViejo(dicho));
  let c = 0; for (const p of e) if (d.has(p)) c++;
  return c / e.length >= 0.6;
}
// El manejador viejo solo miraba desde resultIndex, y perdía lo dicho
// antes de cada reinicio de sesión.
function simularViejo(esperado, sesiones) {
  for (const sesion of sesiones) {
    const results = [];
    for (const frase of sesion) {
      results.push([{ transcript: frase }]);
      const idx = results.length - 1;
      let t = '';
      for (let i = idx; i < results.length; i++) t += ' ' + results[i][0].transcript;
      if (coincideViejo(esperado, t)) return true;
    }
  }
  return false;
}

async function arrancarApp(opciones) {
  opciones = opciones || {};

  const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8')
    .replace(/<script src="[^"]+"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://ejemplo.test/' });
  const { window } = dom;

  // Ajustes de partida: sin avance automático para navegar paso a paso,
  // y con el reconocimiento activado.
  window.localStorage.setItem('rezar_autoavanzar', 'false');
  window.localStorage.setItem('rezar_reconocer', 'true');
  window.localStorage.setItem('rezar_velocidad_migrada', 'true');

  const registro = { plays: [], reconocedores: [], habloSistema: 0 };

  // ---------------- Reproductor de audio falso ----------------
  const P = window.HTMLMediaElement.prototype;
  Object.defineProperty(P, 'paused', { get() { return this._pausado !== false; }, configurable: true });
  Object.defineProperty(P, 'ended', { get() { return !!this._terminado; }, configurable: true });
  P.load = function () {};
  P.pause = function () {
    if (this._pausado === false) {
      this._pausado = true;
      clearTimeout(this._temporizador);
      setTimeout(() => this.dispatchEvent(new window.Event('pause')), 0);
    }
  };
  P._terminarAhora = function () {
    this._pausado = true; this._terminado = true;
    this.dispatchEvent(new window.Event('pause'));
    this.dispatchEvent(new window.Event('ended'));
  };
  P.play = function () {
    const src = String(this.src).replace('https://ejemplo.test/', '');
    const micAbierto = registro.reconocedores.some((r) => r.activo);
    registro.plays.push({ src, t: Date.now(), micAbierto, id: this.id });
    if (src.startsWith('data:')) { this._pausado = false; return Promise.resolve(); }

    if (registro.bloquearSiguientePlay) {
      registro.bloquearSiguientePlay = false;
      const e = new window.DOMException('bloqueado', 'NotAllowedError');
      return Promise.reject(e);
    }
    this._pausado = false; this._terminado = false;
    setTimeout(() => this.dispatchEvent(new window.Event('playing')), 0);
    clearTimeout(this._temporizador);
    const dur = registro.duracionAudio || 40;
    this._temporizador = setTimeout(() => { if (this._pausado === false) this._terminarAhora(); }, dur);
    return Promise.resolve();
  };

  // ---------------- Voz del sistema falsa ----------------
  window.speechSynthesis = {
    getVoices: () => [], cancel: () => {},
    speak: (u) => {
      registro.habloSistema++;
      if (registro.sistemaNuncaTermina) return;   // el fallo de Android
      setTimeout(() => { if (u.onend) u.onend(); u.dispatchEvent && u.dispatchEvent(new window.Event('end')); }, 20);
    }
  };
  window.SpeechSynthesisUtterance = function (t) {
    const et = new window.EventTarget();
    this.text = t;
    this.addEventListener = et.addEventListener.bind(et);
    this.dispatchEvent = et.dispatchEvent.bind(et);
  };

  // ---------------- Reconocedor falso ----------------
  class ReconocedorFalso {
    constructor() {
      this.activo = false; this.results = []; this.lang = ''; this.eventos = [];
      registro.reconocedores.push(this);
    }
    start(pista) {
      if (this.activo) throw new window.DOMException('ya iniciado', 'InvalidStateError');
      this.activo = true; this.results = [];
      this.eventos.push({ op: 'start', t: Date.now(), conPista: !!pista });
      if (registro.redCaida) setTimeout(() => { this.onerror && this.onerror({ error: 'network' }); this._fin(); }, 5);
    }
    abort() { this.eventos.push({ op: 'abort', t: Date.now() }); if (this.activo) setTimeout(() => this._fin(), 30); }
    stop() { this.eventos.push({ op: 'stop', t: Date.now() }); if (this.activo) setTimeout(() => this._fin(), 30); }
    _fin() {
      if (!this.activo) return;
      this.activo = false;
      this.eventos.push({ op: 'end', t: Date.now() });
      if (this.onend) this.onend();
    }
    // Ayudas para la prueba: el usuario dice algo.
    decir(frase, final) {
      if (!this.activo) return false;
      const ultimo = this.results[this.results.length - 1];
      const r = [{ transcript: frase }]; r.isFinal = final !== false;
      if (ultimo && !ultimo.isFinal) this.results[this.results.length - 1] = r; else this.results.push(r);
      if (this.onresult) this.onresult({ resultIndex: this.results.length - 1, results: this.results });
      return true;
    }
    cortarComoAndroid() { this._fin(); }
  }
  window.SpeechRecognition = ReconocedorFalso;
  window.webkitSpeechRecognition = ReconocedorFalso;

  Object.defineProperty(window.navigator, 'serviceWorker', { value: { register: () => Promise.resolve({}) }, configurable: true });
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {}, kind: 'audio' }] }),
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'default', label: 'Predeterminado - Auriculares (WH-1000XM4 Hands-Free)' },
        { kind: 'audioinput', deviceId: 'mic-bt', label: 'Auriculares (WH-1000XM4 Hands-Free)' },
        { kind: 'audioinput', deviceId: 'mic-pc', label: 'Micrófono (Realtek Audio)' }
      ],
      addEventListener: () => {}
    },
    configurable: true
  });

  const acciones = {};
  Object.defineProperty(window.navigator, 'mediaSession', {
    value: { setActionHandler: (a, fn) => { acciones[a] = fn; }, metadata: null, playbackState: 'none' },
    configurable: true
  });
  window.MediaMetadata = function (m) { Object.assign(this, m); };

  window.indexedDB = undefined;
  window.fetch = async (url) => {
    url = String(url).replace('https://ejemplo.test/', '');
    const p = path.join(SITIO, url.split('?')[0]);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const buf = fs.readFileSync(p);
      return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), text: async () => buf.toString('utf8') };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  for (const f of ['liturgia.js', 'voz-comun.js', 'reproductor.js', 'voz-previa.js', 'voz-fish.js', 'app.js']) {
    window.eval(fs.readFileSync(path.join(RAIZ, f), 'utf8'));
  }

  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const clic = (nodo) => nodo.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const campo = $('campo-fecha');
  campo.value = '2026-09-21';
  campo.dispatchEvent(new window.Event('change'));
  clic(doc.querySelectorAll('#lista-horas .hora-item')[1]);   // Laudes
  await esperar(200);

  const indice = () => parseInt(($('oracion-folio').textContent || '0').split('·')[0], 10) - 1;
  async function irAPaso(n) {
    for (let i = 0; i < 80 && indice() < n; i++) { clic($('btn-continuar')); await esperar(15); }
    await esperar(60);
  }
  const reconocedor = () => registro.reconocedores[registro.reconocedores.length - 1];

  async function esperarQue(cond, maxMs) {
    const fin = Date.now() + (maxMs || 4000);
    while (Date.now() < fin) { if (cond()) return true; await esperar(20); }
    return false;
  }
  const esperarEscucha = () => esperarQue(() => reconocedor() && reconocedor().activo);
  const playsDeVoz = () => registro.plays.filter((p) => p.id === 'reproductor-voz' && !p.src.startsWith('data:'));
  async function esperarAudioNuevo(desde) {
    return esperarQue(() => playsDeVoz().length > desde);
  }

  return { window, doc, $, clic, registro, irAPaso, indice, reconocedor, acciones,
           esperarQue, esperarEscucha, playsDeVoz, esperarAudioNuevo };
}

(async () => {
  console.log('\n=== RECONOCIMIENTO DE VOZ ===');
  console.log('(cada caso: primero la lógica anterior, luego la nueva, con las mismas palabras)\n');

  // Caso 1: la antífona dicha con una pausa natural en la coma.
  {
    const app = await arrancarApp();
    await app.irAPaso(7);    // Ant. "Venid, adoremos al Señor, rey de los apóstoles."
    await app.esperarEscucha();
    const esperado = app.$('oracion-texto').textContent;
    const partes = ['venid adoremos al señor', 'rey de los apóstoles'];
    const antes = simularViejo(esperado, [partes]);
    const pasoAntes = app.indice();
    app.reconocedor().decir(partes[0], true); await esperar(10);
    app.reconocedor().decir(partes[1], true); await esperar(100);
    comprobar('Antífona con una pausa en la coma',
      !antes && app.indice() === pasoAntes + 1,
      'antes: ' + (antes ? 'avanzaba' : 'NO avanzaba') + ' · ahora: ' + (app.indice() > pasoAntes ? 'avanza' : 'no avanza'));
  }

  // Caso 2: antífona larga dicha en tres respiros.
  {
    const app = await arrancarApp();
    await app.irAPaso(14);   // "Éste es mi mandamiento: que os améis unos a otros como yo os he amado."
    await app.esperarEscucha();
    const esperado = app.$('oracion-texto').textContent;
    const partes = ['este es mi mandamiento', 'que os améis unos a otros', 'como yo os he amado'];
    const antes = simularViejo(esperado, [partes]);
    const pasoAntes = app.indice();
    for (const parte of partes) { app.reconocedor().decir(parte, true); await esperar(10); }
    await esperar(100);
    comprobar('Antífona larga dicha en tres respiros',
      !antes && app.indice() === pasoAntes + 1,
      'antes: ' + (antes ? 'avanzaba' : 'NO avanzaba') + ' · ahora: ' + (app.indice() > pasoAntes ? 'avanza' : 'no avanza'));
  }

  // Caso 3: Android corta la sesión a mitad y se reinicia.
  {
    const app = await arrancarApp();
    await app.irAPaso(7);
    await app.esperarEscucha();
    const esperado = app.$('oracion-texto').textContent;
    const antes = simularViejo(esperado, [['venid adoremos al señor'], ['rey de los apóstoles']]);
    const pasoAntes = app.indice();
    app.reconocedor().decir('venid adoremos al señor', true);
    app.reconocedor().cortarComoAndroid();
    const reabrio = await app.esperarEscucha();
    app.reconocedor().decir('rey de los apóstoles', true);
    await esperar(100);
    comprobar('Sesión cortada a mitad (Android) y reiniciada',
      !antes && reabrio && app.indice() === pasoAntes + 1,
      'antes: ' + (antes ? 'avanzaba' : 'NO avanzaba') + ' · ahora: ' + (app.indice() > pasoAntes ? 'avanza' : 'no avanza'));
  }

  // Caso 4: el reconocedor confunde la forma de una palabra.
  {
    const app = await arrancarApp();
    await app.irAPaso(6);    // R. "Y mi boca proclamará tu alabanza"
    await app.esperarEscucha();
    const esperado = app.$('oracion-texto').textContent;
    const dicho = 'y mi boca proclamaran tus alabanzas';
    const antes = simularViejo(esperado, [[dicho]]);
    const pasoAntes = app.indice();
    app.reconocedor().decir(dicho, true);
    await esperar(100);
    comprobar('Palabras casi iguales ("proclamarán tus alabanzas")',
      app.indice() === pasoAntes + 1,
      'antes: ' + (antes ? 'avanzaba' : 'NO avanzaba') + ' · ahora: ' + (app.indice() > pasoAntes ? 'avanza' : 'no avanza'));
  }

  // Caso 5: el idioma según la región.
  {
    const app = await arrancarApp();
    await app.irAPaso(6); await esperar(50);
    comprobar('Reconoce en español de la región del usuario',
      app.reconocedor().lang === 'es-CO',
      'lang = ' + app.reconocedor().lang + ' (navegador en inglés, zona horaria Bogotá)');
  }

  // Caso 6: navegador sin servicio de reconocimiento (Brave).
  {
    const app = await arrancarApp();
    app.registro.redCaida = true;
    await app.irAPaso(6);
    await esperar(1500);
    const nota = app.$('nota-reconocer');
    comprobar('Sin servicio de reconocimiento: avisa y deja de reintentar',
      !nota.hidden && /no está respondiendo/.test(nota.textContent) && app.registro.reconocedores[0].eventos.filter((e) => e.op === 'start').length <= 4,
      app.registro.reconocedores[0].eventos.filter((e) => e.op === 'start').length + ' intentos y aviso en pantalla');
  }

  console.log('\n=== AUDIO Y AUDÍFONOS ===\n');

  // Caso 7: el micrófono nunca está abierto mientras suena algo, y se
  // espera a que los audífonos vuelvan al modo normal.
  {
    const app = await arrancarApp();
    await app.irAPaso(6);    // respuesta: escucha
    await app.esperarEscucha();
    const pasoAntes = app.indice();
    const n = app.playsDeVoz().length;
    app.reconocedor().decir('y mi boca proclamará tu alabanza', true);
    await app.esperarAudioNuevo(n);      // la antífona 7 se lee en voz alta
    const fin = app.reconocedor().eventos.filter((e) => e.op === 'end').pop();
    const play = app.playsDeVoz()[n];
    const conMic = app.registro.plays.filter((p) => p.micAbierto && !p.src.startsWith('data:'));
    comprobar('Nada suena con el micrófono abierto',
      conMic.length === 0, conMic.length + ' audios arrancaron con el micrófono abierto');
    comprobar('Espera a que los audífonos salgan del "modo llamada"',
      app.indice() === pasoAntes + 1 && play && fin && play.t - fin.t >= 750,
      play && fin ? ('el audio arrancó ' + (play.t - fin.t) + ' ms después de cerrar el micrófono') : 'no sonó');
    comprobar('La antífona usa el audio preparado del día (antes: voz del sistema)',
      play && /^dias\/voz\//.test(play.src) && app.registro.habloSistema === 0,
      play ? play.src : 'no sonó');
  }

  // Caso 8: se desconectan los audífonos a mitad de una lectura.
  {
    const app = await arrancarApp();
    app.registro.duracionAudio = 1500;
    await app.irAPaso(11);   // título del himno (sin audio propio)
    const n = app.playsDeVoz().length;
    app.clic(app.$('btn-continuar'));    // 12: versos del himno
    await app.esperarAudioNuevo(n);
    await esperar(50);
    const pasoAntes = app.indice();
    app.$('reproductor-voz').pause();    // lo que hace el navegador al desconectarse los audífonos
    await esperar(80);
    const boton = app.$('btn-escuchar');
    const avisa = /En pausa/.test(app.$('oracion-estado').textContent) && boton.textContent === '▶';
    const textoAviso = app.$('oracion-estado').textContent;
    await esperar(1800);                 // más que lo que duraba el audio
    const noSeSalto = app.indice() === pasoAntes && boton.textContent === '▶';
    const playsAntes = app.playsDeVoz().length;
    app.clic(boton);
    await esperar(40);
    const reanudo = app.playsDeVoz().length > playsAntes && boton.textContent === '🔊' &&
                    /Escuchando/.test(app.$('oracion-estado').textContent);
    comprobar('Audífonos desconectados: avisa en pantalla y ofrece ▶', avisa, textoAviso);
    comprobar('…no se salta el texto mientras está en pausa', noSeSalto);
    comprobar('…y ▶ sigue desde donde iba, con el aviso anterior restaurado', reanudo,
      app.$('oracion-estado').textContent);
  }

  // Caso 9: el navegador no deja sonar (antes: saltaba el texto o pasaba
  // a la voz robótica).
  {
    const app = await arrancarApp();
    await app.irAPaso(11);
    app.registro.bloquearSiguientePlay = true;
    const n = app.playsDeVoz().length;
    app.clic(app.$('btn-continuar'));    // 12
    await app.esperarAudioNuevo(n);
    await esperar(300);
    const pasoAntes = app.indice();
    const avisa = /Toca ▶/.test(app.$('oracion-estado').textContent);
    const sinVozRobotica = app.registro.habloSistema === 0;
    await esperar(500);
    comprobar('Reproducción bloqueada: pide un toque en vez de saltar o cambiar de voz',
      avisa && sinVozRobotica && app.indice() === pasoAntes,
      app.$('oracion-estado').textContent + ' · voz del sistema usada ' + app.registro.habloSistema + ' veces');
  }

  // Caso 10: botones de los audífonos (Media Session).
  {
    const app = await arrancarApp();
    app.registro.duracionAudio = 1500;
    await app.irAPaso(11);
    const n = app.playsDeVoz().length;
    app.clic(app.$('btn-continuar'));
    await app.esperarAudioNuevo(n);
    await esperar(50);
    const registrados = ['play', 'pause', 'nexttrack', 'previoustrack'].every((a) => typeof app.acciones[a] === 'function');
    app.acciones.pause();
    await esperar(60);
    const pauso = app.$('btn-escuchar').textContent === '▶';
    const playsAntes = app.playsDeVoz().length;
    app.acciones.play();
    await esperar(40);
    const siguio = app.playsDeVoz().length > playsAntes;
    const pasoAntes = app.indice();
    app.acciones.nexttrack();
    await esperar(60);
    comprobar('Botones de los audífonos: pausa, play y siguiente',
      registrados && pauso && siguio && app.indice() === pasoAntes + 1,
      'registrados ' + registrados + ' · pausa ' + pauso + ' · play ' + siguio);
  }

  // Caso 11: la voz del sistema nunca avisa que terminó (pasa en
  // Android): antes la app se quedaba colgada para siempre.
  {
    const app = await arrancarApp();
    const check = app.$('check-autoavanzar');
    check.checked = true;
    check.dispatchEvent(new app.window.Event('change'));
    await app.irAPaso(4);
    app.registro.sistemaNuncaTermina = true;
    const original = app.window.VozPrevia.hablar;
    app.window.VozPrevia.hablar = () => Promise.reject(new Error('no-se-pudo-cargar'));
    app.clic(app.$('btn-continuar'));      // 5: "Señor, abre mis labios" → voz del sistema
    const t0 = Date.now();
    const siguio = await app.esperarQue(() => app.indice() >= 6, 12000);
    app.window.VozPrevia.hablar = original;
    comprobar('La voz del sistema no deja la app colgada si nunca avisa que terminó',
      app.registro.habloSistema > 0 && siguio,
      siguio ? ('siguió sola a los ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s') : 'se quedó colgada');
  }

  // Caso 12: selector de micrófono.
  {
    const app = await arrancarApp();
    app.$('btn-config').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await esperar(100);
    const opciones = [...app.$('select-mic').options].map((o) => o.textContent);
    const resaltado = app.$('nota-mic').classList.contains('nota-importante');
    app.$('select-mic').value = 'mic-pc';
    app.$('select-mic').dispatchEvent(new app.window.Event('change'));
    await app.irAPaso(6); await esperar(150);
    const conPista = app.reconocedor().eventos.some((e) => e.op === 'start' && e.conPista);
    comprobar('Detecta que el micrófono predeterminado es el de los audífonos y lo avisa', resaltado,
      opciones.join(' | '));
    comprobar('Con el micrófono del computador elegido, el reconocedor usa ese', conPista);
  }

  // Caso 13: Ajustes dice qué voz suena, sin hablar de claves.
  {
    const app = await arrancarApp();
    await app.irAPaso(11);
    const n = app.playsDeVoz().length;
    app.clic(app.$('btn-continuar'));
    await app.esperarAudioNuevo(n);
    app.clic(app.$('btn-config'));
    await esperar(50);
    const linea = app.$('estado-voz').textContent;
    const fishEscondido = app.$('campo-clave-voz').closest('details') && !app.$('campo-clave-voz').closest('details').open;
    comprobar('Ajustes dice que la voz está preparada, y lo de Fish queda en "avanzado"',
      /preparada/.test(linea) && !/clave/i.test(linea) && fishEscondido, linea);
  }

  console.log('\n' + (fallos === 0 ? 'TODO OK' : fallos + ' FALLOS'));
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
