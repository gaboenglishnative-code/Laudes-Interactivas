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

  function construirUrl(fecha, horaId) {
    const y = fecha.getFullYear();
    const m = MESES[fecha.getMonth()];
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${REPO_BASE}/${y}/${m}/${d}/${horaId}.htm`;
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

  const voz = {
    tasa: parseFloat(localStorage.getItem('rezar_velocidad') || '0.88'),
    autoavanzar: localStorage.getItem('rezar_autoavanzar') !== 'false',
    reconocerVoz: localStorage.getItem('rezar_reconocer') !== 'false',
    vocesListas: false
  };

  function elegirVozEspanola() {
    const voces = speechSynthesis.getVoices();
    return (
      voces.find(v => v.lang && v.lang.toLowerCase().startsWith('es-es')) ||
      voces.find(v => v.lang && v.lang.toLowerCase().startsWith('es')) ||
      null
    );
  }

  function hablar(texto, alTerminar) {
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
    if ('speechSynthesis' in window) speechSynthesis.cancel();
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

  let reconocedor = null;
  let reconociendoActivo = false;

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

  function detenerEscucha() {
    reconociendoActivo = false;
    if (el.indicadorEscucha) el.indicadorEscucha.hidden = true;
    if (reconocedor) {
      reconocedor.onresult = null;
      reconocedor.onerror = null;
      reconocedor.onend = null;
      try { reconocedor.stop(); } catch (e) { /* ya estaba detenido */ }
      reconocedor = null;
    }
  }

  function escucharTurno(textoEsperado, alConfirmar) {
    if (!voz.reconocerVoz || !SOPORTA_RECONOCIMIENTO) return;

    detenerEscucha();

    reconocedor = new CtorReconocimiento();
    reconocedor.lang = 'es-ES';
    reconocedor.continuous = true;
    reconocedor.interimResults = true;
    reconocedor.maxAlternatives = 1;

    reconociendoActivo = true;
    if (el.indicadorEscucha) el.indicadorEscucha.hidden = false;

    reconocedor.onresult = (evento) => {
      let transcrito = '';
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        transcrito += ' ' + evento.results[i][0].transcript;
      }
      if (coincideSuficiente(textoEsperado, transcrito)) {
        detenerEscucha();
        alConfirmar();
      }
    };

    reconocedor.onerror = (evento) => {
      if (evento.error === 'not-allowed' || evento.error === 'service-not-allowed') {
        voz.reconocerVoz = false;
        localStorage.setItem('rezar_reconocer', 'false');
        if (el.checkReconocer) el.checkReconocer.checked = false;
        if (el.notaReconocer) {
          el.notaReconocer.hidden = false;
          el.notaReconocer.textContent = 'No pude usar el micrófono (permiso denegado). Actívalo en los ajustes del navegador si quieres esta función.';
        }
      }
      detenerEscucha();
    };

    reconocedor.onend = () => {
      if (reconociendoActivo) {
        try { reconocedor.start(); } catch (e) { detenerEscucha(); }
      }
    };

    try {
      reconocedor.start();
    } catch (e) {
      detenerEscucha();
    }
  }

  // ---------------------------------------------------------------------
  // Estado y referencias del DOM
  // ---------------------------------------------------------------------

  const el = {
    inicio: document.getElementById('pantalla-inicio'),
    carga: document.getElementById('pantalla-carga'),
    error: document.getElementById('pantalla-error'),
    oracion: document.getElementById('pantalla-oracion'),

    campoFecha: document.getElementById('campo-fecha'),
    btnHoy: document.getElementById('btn-hoy'),
    listaHoras: document.getElementById('lista-horas'),
    notaInstalar: document.getElementById('nota-instalar'),
    btnInstalar: document.getElementById('btn-instalar'),

    textoCarga: document.getElementById('texto-carga'),
    textoError: document.getElementById('texto-error'),
    btnVolverError: document.getElementById('btn-volver-error'),

    oracionTitulo: document.getElementById('oracion-titulo'),
    regletaProgreso: document.getElementById('regleta-progreso'),
    panelConfig: document.getElementById('panel-config'),
    btnConfig: document.getElementById('btn-config'),
    rangoVelocidad: document.getElementById('rango-velocidad'),
    checkAutoavanzar: document.getElementById('check-autoavanzar'),
    checkReconocer: document.getElementById('check-reconocer'),
    notaReconocer: document.getElementById('nota-reconocer'),
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
    for (const p of [el.inicio, el.carga, el.error, el.oracion]) {
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

    const url = construirUrl(estado.fechaSeleccionada, hora.id);

    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('no-encontrado');
      const html = await resp.text();
      const pasos = parsearLiturgia(html);

      if (!pasos.length) throw new Error('vacio');

      marcarPiezasCantables(pasos);
      await cargarAudiosDePasos(pasos);

      estado.pasos = pasos;
      estado.indice = 0;
      el.oracionTitulo.textContent = hora.nombre;
      mostrarPantalla(el.oracion);
      mostrarPaso();
    } catch (err) {
      el.textoError.textContent =
        `No encontré el texto de ${hora.nombre.toLowerCase()} para el ${el.campoFecha.value}. ` +
        `Puede que esa hora no exista para este día, o que la fuente aún no la haya publicado.`;
      mostrarPantalla(el.error);
    }
  }

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

    // lectura: se lee sola y avanza, salvo que el usuario lo desactive
    el.estado.textContent = 'Escuchando…';
    el.estado.classList.remove('es-turno');
    el.btnContinuar.textContent = 'Saltar';

    hablar(paso.texto, () => {
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
    if (paso) hablar(paso.texto);
  });

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
