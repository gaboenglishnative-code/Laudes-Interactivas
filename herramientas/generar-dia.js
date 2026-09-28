#!/usr/bin/env node
//
// Generador nocturno de Modo Rezar.
//
// Prepara los días que vienen: lee la liturgia de la fuente, la parte en
// pasos con EL MISMO código que usa la app (liturgia.js), genera el audio
// de cada bloque que falte, y deja todo listo como archivos estáticos.
// Así cualquiera puede rezar sin poner ninguna clave: el audio ya está
// hecho.
//
// Esto funciona porque la Liturgia de las Horas de un día es idéntica
// para todo el mundo. No hay nada personalizado que generar por usuario.
//
// La voz sale de un motor LOCAL (gratis, en la propia máquina; ver
// herramientas/motores_voz.py), o de Fish Audio si se pide:
//
//   --motor supertonic        (por defecto) Supertonic 3, voz M4: la más
//                             natural de las ligeras, verificada con Whisper
//   --motor supertonic-F1     otra voz de Supertonic (M1..M5, F1..F5)
//   --motor kokoro            Kokoro-82M, voz em_alex
//   --motor qwen3-clon        Qwen3-TTS repitiendo voz/referencia.wav
//   --motor omnivoice-clon    OmniVoice repitiendo voz/referencia.wav
//   --motor chatterbox-clon   Chatterbox repitiendo voz/referencia.wav
//   --motor fish              Fish Audio (API; necesita FISH_API_KEY)
//
// También se puede elegir con la variable de entorno MOTOR_VOZ.
//
// Uso:
//   node herramientas/generar-dia.js --salida sitio --cache voz-cache
//   node herramientas/generar-dia.js --dias 3 --desde 2026-09-21
//   node herramientas/generar-dia.js --horas laudes,visperas
//   node herramientas/generar-dia.js --seco        (sin generar nada)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');

// liturgia.js necesita DOMParser y Node (los del DOM). Se ponen como
// globales ANTES de cargarlo.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;

const raiz = path.resolve(__dirname, '..');
const L = require(path.join(raiz, 'liturgia.js'));
const VC = require(path.join(raiz, 'voz-comun.js'));

// ---------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------

function leerArgs(argv) {
  const args = {
    dias: 3, desde: null, salida: 'sitio', cache: 'voz-cache', seco: false,
    concurrencia: 4, motor: process.env.MOTOR_VOZ || 'supertonic', horas: null,
    ref: path.join(raiz, 'voz', 'referencia.wav'),
    refTexto: path.join(raiz, 'voz', 'referencia.txt')
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seco') args.seco = true;
    else if (a === '--dias') args.dias = parseInt(argv[++i], 10);
    else if (a === '--desde') args.desde = argv[++i];
    else if (a === '--salida') args.salida = argv[++i];
    else if (a === '--cache') args.cache = argv[++i];
    else if (a === '--concurrencia') args.concurrencia = parseInt(argv[++i], 10);
    else if (a === '--motor') args.motor = argv[++i];
    else if (a === '--horas') args.horas = argv[++i].split(',').map((h) => h.trim()).filter(Boolean);
    else if (a === '--ref') args.ref = path.resolve(argv[++i]);
    else if (a === '--ref-texto') args.refTexto = path.resolve(argv[++i]);
  }
  return args;
}

const args = leerArgs(process.argv);

const DIR_SALIDA = path.resolve(args.salida);
const DIR_CACHE = path.resolve(args.cache);
const DIR_DIAS = path.join(DIR_SALIDA, 'dias');
const DIR_VOZ = path.join(DIR_DIAS, 'voz');

// Ruta tal como la ve la app, desde la raíz del sitio.
const RUTA_VOZ_WEB = 'dias/voz';

const PYTHON = process.env.PYTHON || 'python3';
const MOTORES_PY = path.join(__dirname, 'motores_voz.py');
const ES_FISH = args.motor === 'fish';

function argsReferencia() {
  return fs.existsSync(args.ref) ? ['--ref', args.ref, '--ref-texto', args.refTexto] : [];
}

// ---------------------------------------------------------------------
// Nombre de cada audio: el hash de voz + texto
//
// Un salmo que ya se generó hace tres semanas se reutiliza tal cual
// cuando vuelve a tocar (el salterio rota cada 4 semanas). Y como la voz
// entra en el hash, cambiar de motor o de voz nunca reutiliza audio de
// otra voz por error.
// ---------------------------------------------------------------------

function claveDeVoz() {
  // Fish conserva su clave de siempre para no invalidar lo ya generado.
  if (ES_FISH) return VC.VOICE_ID;
  const salida = execFileSync(PYTHON, [MOTORES_PY, 'clave', '--motor', args.motor, ...argsReferencia()], {
    encoding: 'utf8'
  });
  return salida.trim();
}

let CLAVE_VOZ = null;

function nombreDeAudio(texto) {
  const hash = crypto.createHash('sha256')
    .update(CLAVE_VOZ + '::' + texto, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return hash + '.mp3';
}

const existeEnCache = (texto) => fs.existsSync(path.join(DIR_CACHE, nombreDeAudio(texto)));

// ---------------------------------------------------------------------
// Motor local: UNA sola llamada a Python para todo lo que falte, así el
// modelo se carga una vez por noche y no una vez por hora.
// ---------------------------------------------------------------------

function generarLocal(faltantes) {
  const lista = faltantes.map((texto) => ({ texto, archivo: path.join(DIR_CACHE, nombreDeAudio(texto)) }));
  const tmp = path.join(os.tmpdir(), 'modo-rezar-pendientes-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(lista));
  try {
    const r = spawnSync(PYTHON, [MOTORES_PY, 'generar', '--motor', args.motor, '--lista', tmp, ...argsReferencia()], {
      stdio: 'inherit'
    });
    if (r.status !== 0) throw new Error('el motor de voz ' + args.motor + ' terminó con error');
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* nada */ }
  }
  const hechos = lista.filter((x) => fs.existsSync(x.archivo)).length;
  return { generados: hechos, fallidos: lista.length - hechos };
}

// ---------------------------------------------------------------------
// Fish Audio (API): se conserva por si algún día se quiere volver
// ---------------------------------------------------------------------

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pedirAFish(texto, intento) {
  intento = intento || 1;
  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Falta la variable de entorno FISH_API_KEY.'), { clase: 'clave' });

  const resp = await fetch(VC.API_URL, {
    method: 'POST',
    headers: VC.cabeceras(apiKey),
    body: JSON.stringify(VC.cuerpoPeticion(texto, 1))
  });

  if (!resp.ok) {
    let detalle = '';
    // Solo el cuerpo: las cabeceras llevan la clave y no se tocan.
    try { detalle = (await resp.text()).slice(0, 300); } catch (e) { /* nada */ }
    const fallo = VC.clasificarError(resp.status, detalle);
    if ((fallo.clase === 'ritmo' || fallo.clase === 'servidor') && intento < 5) {
      await dormir(1000 * Math.pow(2, intento));
      return pedirAFish(texto, intento + 1);
    }
    throw Object.assign(new Error(fallo.mensaje), { clase: fallo.clase });
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('Fish Audio devolvió un audio vacío.');
  return buf;
}

async function generarConFish(faltantes) {
  let generados = 0;
  let fallidos = 0;
  let siguiente = 0;

  async function trabajador() {
    while (siguiente < faltantes.length) {
      const texto = faltantes[siguiente++];
      try {
        fs.writeFileSync(path.join(DIR_CACHE, nombreDeAudio(texto)), await pedirAFish(texto));
        generados++;
      } catch (err) {
        fallidos++;
        console.log('   ! ' + err.message + ' — "' + texto.slice(0, 60) + '…"');
        if (err.clase === 'clave' || err.clase === 'voz' || err.clase === 'cuota') throw err;
      }
    }
  }

  const hilos = Math.max(1, Math.min(args.concurrencia, faltantes.length));
  await Promise.all(Array.from({ length: hilos }, trabajador));
  return { generados, fallidos };
}

// ---------------------------------------------------------------------
// Leer una hora de la fuente
// ---------------------------------------------------------------------

async function leerHora(fecha, hora) {
  let html;
  try {
    html = await L.obtenerHTMLHora(fecha, hora.id);
  } catch (err) {
    if (err && err.opciones && err.opciones.length) {
      // Día con varias celebraciones posibles. El generador toma la
      // primera; la app sigue preguntando cuando se entra a mano.
      html = await L.obtenerHTMLHora(fecha, hora.id, err.opciones[0].numero);
    } else {
      return null;
    }
  }
  const pasos = L.prepararPasos(html);
  return pasos.length ? pasos : null;
}

function pasosParaGuardar(pasos) {
  // Cada paso lleva la lista de archivos de audio de sus bloques, en
  // orden. Si alguno falta, va null y la app lo lee por su cuenta.
  return pasos.map((paso) => {
    const salida = { tipo: paso.tipo, etiqueta: paso.etiqueta, texto: paso.texto };
    if (paso.partes) salida.partes = paso.partes;
    if (paso.pieza) salida.pieza = paso.pieza;

    if (L.pasoSeLee(paso)) {
      salida.audios = L.bloquesDelPaso(paso).map((b) =>
        existeEnCache(b) ? RUTA_VOZ_WEB + '/' + nombreDeAudio(b) : null);
      if (salida.audios.every((a) => a === null)) delete salida.audios;
    }
    return salida;
  });
}

// ---------------------------------------------------------------------

async function principal() {
  fs.mkdirSync(DIR_CACHE, { recursive: true });
  fs.mkdirSync(DIR_VOZ, { recursive: true });

  if (/-clon$/.test(args.motor) && !fs.existsSync(args.ref)) {
    throw new Error('El motor ' + args.motor + ' repite una voz de referencia, y falta ' +
      path.relative(raiz, args.ref) + '. Sale del workflow "Probar voces locales" ' +
      '(referencia.wav y referencia.txt): súbelos a la carpeta voz/ del repositorio.');
  }

  CLAVE_VOZ = claveDeVoz();
  console.log('motor de voz: ' + args.motor + '  (' + CLAVE_VOZ.slice(0, 60) + ')');

  const horas = args.horas ? L.HORAS.filter((h) => args.horas.includes(h.id)) : L.HORAS;
  const desde = args.desde ? L.desdeISO(args.desde) : new Date();

  // --- 1. Leer todo lo que hay que preparar -------------------------
  const leidas = [];   // { iso, hora, pasos }
  for (let d = 0; d < args.dias; d++) {
    const fecha = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() + d);
    const iso = L.fechaISO(fecha);
    for (const hora of horas) {
      let pasos = null;
      try { pasos = await leerHora(fecha, hora); } catch (e) { pasos = null; }
      if (!pasos) { console.log('   ' + iso + ' ' + hora.id.padEnd(10) + ' — no publicado todavía'); continue; }
      leidas.push({ iso, hora, pasos });
    }
  }

  // --- 2. Generar lo que falte, todo de una vez ---------------------
  const todos = new Set();
  for (const l of leidas) for (const b of L.bloquesDeVoz(l.pasos)) todos.add(b);
  const faltantes = [...todos].filter((b) => !existeEnCache(b));
  const bytesNuevos = faltantes.reduce((s, t) => s + Buffer.byteLength(t, 'utf8'), 0);

  console.log('\nbloques: ' + todos.size + ' en total, ' + faltantes.length + ' por generar (' +
              bytesNuevos.toLocaleString() + ' bytes de texto)');

  let resultado = { generados: 0, fallidos: 0 };
  const t0 = Date.now();
  if (faltantes.length && !args.seco) {
    resultado = ES_FISH ? await generarConFish(faltantes) : generarLocal(faltantes);
  }
  if (faltantes.length && !args.seco) {
    console.log('generados: ' + resultado.generados + ', fallidos: ' + resultado.fallidos +
                ' — en ' + ((Date.now() - t0) / 60000).toFixed(1) + ' min');
  }

  // --- 3. Escribir los días -----------------------------------------
  const indice = { generado: new Date().toISOString(), motor: args.motor, voz: CLAVE_VOZ, dias: {} };
  for (const l of leidas) {
    fs.mkdirSync(path.join(DIR_DIAS, l.iso), { recursive: true });
    fs.writeFileSync(path.join(DIR_DIAS, l.iso, l.hora.id + '.json'), JSON.stringify({
      fecha: l.iso,
      hora: l.hora.id,
      nombre: l.hora.nombre,
      generado: new Date().toISOString(),
      motor: args.motor,
      pasos: pasosParaGuardar(l.pasos)
    }));
    (indice.dias[l.iso] = indice.dias[l.iso] || []).push(l.hora.id);
  }

  // Al sitio solo se copia el audio de los días publicados, no toda la
  // caché histórica: así lo que se despliega se queda pequeño y estable
  // por mucho que la caché crezca con los años.
  const usados = new Set();
  for (const l of leidas) {
    for (const b of L.bloquesDeVoz(l.pasos)) if (existeEnCache(b)) usados.add(nombreDeAudio(b));
  }
  let copiados = 0;
  for (const nombre of usados) {
    const destino = path.join(DIR_VOZ, nombre);
    if (!fs.existsSync(destino)) { fs.copyFileSync(path.join(DIR_CACHE, nombre), destino); copiados++; }
  }
  fs.writeFileSync(path.join(DIR_DIAS, 'indice.json'), JSON.stringify(indice, null, 2));

  const peso = [...usados].reduce((s, n) => s + fs.statSync(path.join(DIR_VOZ, n)).size, 0);
  console.log('\n---------------------------------------');
  console.log('horas preparadas:    ' + leidas.length + ' (' + Object.keys(indice.dias).length + ' días)');
  console.log('bloques con audio:   ' + usados.size + ' de ' + todos.size + ' (' + copiados + ' copiados al sitio)');
  console.log('peso publicado:      ' + (peso / 1e6).toFixed(1) + ' MB');
  if (resultado.fallidos) console.log('bloques fallidos:    ' + resultado.fallidos + ' (la app los lee con la voz del sistema)');
}

principal().catch((err) => {
  console.error('\nERROR: ' + err.message);
  process.exit(1);
});
