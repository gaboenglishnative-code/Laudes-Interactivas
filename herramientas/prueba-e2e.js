// Prueba de integración de Modo Rezar.
//
// Arranca la app entera en un navegador simulado (jsdom) y comprueba las
// dos rutas que importan:
//
//   Caso 1 — día ya pregenerado: la app lo usa, reproduce los mp3
//            preparados, y NO llama a ninguna API ni a la voz del
//            sistema. Es lo que viven los amigos a quienes se comparte.
//   Caso 2 — día sin pregenerar: la app va a la fuente original, la
//            parsea y lee con la voz que tenga. Nada se rompe.
//
// Uso:
//   npm install jsdom
//   node herramientas/generar-dia.js --seco   (ver qué haría)
//   node herramientas/prueba-e2e.js <carpeta-del-sitio-generado>
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const RAIZ = require('path').resolve(__dirname, '..');
const SITIO = process.argv[2];

const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8')
  .replace(/<script src="[^"]+"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://ejemplo.test/' });
const { window } = dom;

// --- Instrumentos ---
const reproducidos = [];
let llamadasFish = 0;
let hablóNavegador = 0;

Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', { get() { return this._pausado !== false; }, configurable: true });
Object.defineProperty(window.HTMLMediaElement.prototype, 'ended', { get() { return !!this._terminado; }, configurable: true });
window.HTMLMediaElement.prototype.play = function () {
  const src = this.src.replace('https://ejemplo.test/', '');
  this._pausado = false; this._terminado = false;
  if (src.startsWith('data:')) return Promise.resolve();   // desbloqueo con silencio
  reproducidos.push(src);
  // El audio "termina" enseguida para que la cadena avance.
  setTimeout(() => {
    this._pausado = true; this._terminado = true;
    this.dispatchEvent(new window.Event('pause'));
    this.dispatchEvent(new window.Event('ended'));
  }, 0);
  return Promise.resolve();
};
window.HTMLMediaElement.prototype.pause = function () { this._pausado = true; };
window.HTMLMediaElement.prototype.load = function () {};

window.speechSynthesis = {
  getVoices: () => [],
  cancel: () => {},
  speak: (u) => { hablóNavegador++; setTimeout(() => u.onend && u.onend(), 0); }
};
window.SpeechSynthesisUtterance = function (t) { this.text = t; };

const realFetch = globalThis.fetch;
window.fetch = async (url) => {
  url = String(url).replace('https://ejemplo.test/', '');
  if (url.startsWith('https://api.fish.audio')) { llamadasFish++; throw new Error('no deberia llamarse'); }
  // La fuente original sí se consulta de verdad: es justo lo que hay que
  // probar cuando el día no está pregenerado.
  if (url.startsWith('https://raw.githubusercontent.com')) {
    const r = await realFetch(url);
    return { ok: r.ok, status: r.status, text: () => r.text(), json: () => r.json() };
  }
  const p = path.join(SITIO, url.split('?')[0]);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    const buf = fs.readFileSync(p);
    return { ok: true, status: 200, text: async () => buf.toString('utf8'),
             json: async () => JSON.parse(buf.toString('utf8')),
             blob: async () => ({ size: buf.length }), arrayBuffer: async () => buf };
  }
  return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
};

window.indexedDB = undefined;
Object.defineProperty(window.navigator, 'serviceWorker', {
  value: { register: () => Promise.resolve({}) }, configurable: true
});

// --- Cargar los scripts en el mismo orden que la página ---
for (const f of ['liturgia.js', 'voz-comun.js', 'reproductor.js', 'voz-previa.js', 'voz-fish.js', 'app.js']) {
  window.eval(fs.readFileSync(path.join(RAIZ, f), 'utf8'));
}

(async () => {
  const botones = [...window.document.querySelectorAll('#lista-horas .hora-item')];
  console.log('horas en el índice:', botones.length);

  // Fijar la fecha al día que sí está pregenerado.
  const campo = window.document.getElementById('campo-fecha');
  campo.value = '2026-09-21';
  campo.dispatchEvent(new window.Event('change'));

  // Laudes es el segundo botón.
  botones[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));

  // Los primeros pasos son títulos, que no se leen. Se avanza hasta
  // llegar a texto rezado y se le deja leer unos cuantos pasos seguidos.
  const continuar = window.document.getElementById('btn-continuar');
  for (let i = 0; i < 6 && reproducidos.length === 0; i++) {
    continuar.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 600));

  const pantalla = window.document.getElementById('pantalla-oracion');
  const texto = window.document.getElementById('oracion-texto').textContent;

  console.log('pantalla de oración visible:', !pantalla.hidden);
  console.log('primer texto en pantalla:', JSON.stringify(texto.slice(0, 60)));
  console.log('audios reproducidos:', reproducidos.length);
  console.log('  ejemplo:', reproducidos[0] || '(ninguno)');
  console.log('todos son del día pregenerado:',
    reproducidos.length > 0 && reproducidos.every((u) => u.startsWith('dias/voz/')));
  console.log('llamadas a la API de Fish:', llamadasFish, '(debe ser 0)');
  console.log('veces que habló la voz del sistema:', hablóNavegador, '(debe ser 0)');


  const ok1 = !pantalla.hidden && reproducidos.length > 0 &&
              reproducidos.every((u) => u.startsWith('dias/voz/')) &&
              llamadasFish === 0 && hablóNavegador === 0;
  console.log(ok1 ? 'OK caso 1.' : 'FALLA caso 1.');

  // --- Caso 2: un día que NO está pregenerado ---
  console.log('\n=== CASO 2: día sin pregenerar (20 de septiembre) ===');
  reproducidos.length = 0;
  hablóNavegador = 0;

  window.document.getElementById('btn-salir')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));

  campo.value = '2026-09-20';
  campo.dispatchEvent(new window.Event('change'));

  [...window.document.querySelectorAll('#lista-horas .hora-item')][1]
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1500));

  for (let i = 0; i < 6 && hablóNavegador === 0; i++) {
    continuar.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 400));

  const texto2 = window.document.getElementById('oracion-texto').textContent;
  console.log('pantalla de oración visible:', !pantalla.hidden);
  console.log('texto leído de la fuente:', JSON.stringify(texto2.slice(0, 60)));
  console.log('audios pregenerados usados:', reproducidos.length, '(debe ser 0)');
  console.log('veces que habló la voz del sistema:', hablóNavegador, '(debe ser > 0)');

  const ok2 = !pantalla.hidden && reproducidos.length === 0 && hablóNavegador > 0;
  console.log(ok2 ? 'OK caso 2.' : 'FALLA caso 2.');

  console.log(ok1 && ok2
    ? '\nOK: usa el día preparado cuando existe, y el camino normal cuando no.'
    : '\nFALLA');
  process.exit(ok1 && ok2 ? 0 : 1);
})();
