// Núcleo compartido de Modo Rezar.
//
// Todo lo que entiende el HTML de la fuente y lo convierte en pasos
// rezables vive aquí, y NO en app.js, por una razón concreta: este mismo
// archivo lo carga el navegador y lo carga el generador nocturno que
// prepara el audio (ver herramientas/generar-dia.js). Si el parser
// viviera duplicado en los dos lados, cualquier arreglo en uno dejaría
// al otro produciendo un texto distinto — y el audio pregenerado ya no
// correspondería con lo que la app muestra.
//
// Funciona igual como <script> en el navegador (deja window.Liturgia) y
// como módulo de Node (module.exports). En Node hacen falta DOMParser y
// Node (los de jsdom) puestos como globales antes de usar el parser.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    raiz.Liturgia = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // -------------------------------------------------------------------
  // Fuente y URLs
  // -------------------------------------------------------------------

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
    return REPO_BASE + '/' + y + '/' + m + '/' + d;
  }

  function construirUrl(fecha, horaId) {
    return construirCarpetaFecha(fecha) + '/' + horaId + '.htm';
  }

  function fechaISO(fecha) {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function desdeISO(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // -------------------------------------------------------------------
  // Días con varias celebraciones posibles
  //
  // Algunos días (fiestas que aplican solo en ciertos países, o que se
  // pueden sustituir por la feria) no tienen el archivo de la hora
  // directamente: la carpeta del día trae un "index.htm" que ofrece 2 o
  // más carpetas numeradas (1/, 2/...) para elegir.
  // -------------------------------------------------------------------

  function normalizarEspacios(texto) {
    return texto.replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
  }

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
        if (grupo) etiqueta = grupo + ' — ' + etiqueta;
      }

      return { numero: numero, etiqueta: etiqueta || ('Opción ' + numero) };
    });
  }

  // Devuelve el HTML de una hora. Si el día tiene varias celebraciones y
  // no se eligió ninguna, lanza un error con .opciones para que quien
  // llame decida (la app pregunta; el generador toma la primera).
  async function obtenerHTMLHora(fecha, horaId, opcion) {
    const carpeta = construirCarpetaFecha(fecha);
    const url = opcion ? carpeta + '/' + opcion + '/' + horaId + '.htm'
                       : construirUrl(fecha, horaId);

    const resp = await fetch(url, { cache: 'no-store' });
    if (resp.ok) return resp.text();

    if (opcion) throw new Error('no-encontrado');

    const respIndice = await fetch(carpeta + '/index.htm', { cache: 'no-store' });
    if (!respIndice.ok) throw new Error('no-encontrado');

    const htmlIndice = await respIndice.text();
    const doc = new DOMParser().parseFromString(htmlIndice, 'text/html');
    const opciones = detectarOpcionesDelDia(doc);

    if (!opciones.length) throw new Error('no-encontrado');
    if (opciones.length === 1) return obtenerHTMLHora(fecha, horaId, opciones[0].numero);

    const error = new Error('multiples-opciones');
    error.opciones = opciones;
    throw error;
  }

  // -------------------------------------------------------------------
  // Parser: del HTML crudo a una lista de pasos
  //
  // La fuente usa <FONT COLOR="#FF0000"> para rúbricas/etiquetas (V.,
  // R., Ant., títulos de sección) y <FONT COLOR="#000000"> para el texto
  // que se reza. Reconstruimos las líneas a partir de los <BR>
  // respetando ese color heredado.
  // -------------------------------------------------------------------

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
        if (texto) actual.push({ texto: texto, color: color });
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
      const resto = () => normalizarEspacios(runs.slice(1).map(r => r.texto).join(' '));

      if (RE_V.test(primero.texto)) {
        const texto = resto();
        return texto ? { tipo: 'voz', etiqueta: 'Guía', texto: texto } : null;
      }
      if (RE_R.test(primero.texto)) {
        const texto = resto();
        return texto ? { tipo: 'respuesta', etiqueta: 'Responde tú', texto: texto } : null;
      }
      if (RE_ANT.test(primero.texto)) {
        const texto = resto();
        return texto ? { tipo: 'antifona', etiqueta: 'Antífona', texto: texto } : null;
      }
    }

    const todosRojos = runs.every(r => r.color === 'rojo');
    const textoCompleto = normalizarEspacios(runs.map(r => r.texto).join(' '));
    if (!textoCompleto) return null;

    if (todosRojos) return { tipo: 'titulo', etiqueta: 'Sección', texto: textoCompleto };
    return { tipo: 'lectura', etiqueta: 'Se reza', texto: textoCompleto };
  }

  function parsearLiturgia(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cuerpo = doc.getElementById('cuerpo') || doc.body;
    if (!cuerpo) return [];

    const pasos = [];
    for (const linea of extraerLineas(cuerpo)) {
      const paso = clasificarLinea(linea);
      if (paso) pasos.push(paso);
    }
    return pasos;
  }

  // -------------------------------------------------------------------
  // Agrupar líneas de lectura consecutivas (versos de un salmo, líneas
  // de un párrafo largo) en un solo paso de párrafo entero, en vez de
  // uno por cada línea del HTML original.
  // -------------------------------------------------------------------

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
          // como en el breviario (verso bajo verso) en vez de con una
          // línea en blanco entre cada renglón.
          bufer.texto += '\n' + paso.texto;
        }
      } else {
        bufer = null;
        agrupado.push(paso);
      }
    }

    return agrupado;
  }

  // -------------------------------------------------------------------
  // Piezas cantables: títulos de Salmo / Cántico / Himno con sus versos,
  // para poder reemplazarlos por una grabación propia.
  // -------------------------------------------------------------------

  const RE_PIEZA = /^(Salmo|C[áa]ntico|Himno)\b/i;

  function normalizarClave(texto) {
    return texto
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
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
        paso.pieza = { slug: normalizarClave(paso.texto), indiceFinVersos: fin };
      }
    }
  }

  // -------------------------------------------------------------------
  // Avisos que la fuente trae como texto pero no se rezan
  //
  // Laudes empieza casi siempre con "(Si Laudes no es la primera oración
  // del día se sigue el esquema del Invitatorio explicado en el Oficio de
  // Lectura)": es una nota para quien ya rezó otra hora, no algo que se
  // diga. Se quita, y la oración empieza con "Señor, abre mis labios".
  // (Revisado en toda la fuente de mayo a septiembre de 2026: son solo
  // estas dos líneas.)
  // -------------------------------------------------------------------

  const RUBRICAS_QUE_NO_SE_REZAN = [
    /^\(?\s*si laudes no es la primera oracion del dia/,
    /^se sigue el esquema del invitatorio explicado/
  ];

  function sinTildes(texto) {
    return String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  function quitarRubricas(pasos) {
    return pasos.filter((p) => {
      const t = sinTildes(p.texto);
      return !RUBRICAS_QUE_NO_SE_REZAN.some((re) => re.test(t));
    });
  }

  // Dónde empieza la oración: en el primer paso que se reza ("Señor, abre
  // mis labios" / "Dios mío, ven en mi auxilio"), no en los títulos de
  // antes ("LAUDES", "INVOCACIÓN INICIAL"...), que pedirían tocar
  // "Continuar" varias veces antes de empezar. Con "Atrás" se ven igual.
  function primerPasoQueSeReza(pasos) {
    const i = pasos.findIndex((p) => p.tipo !== 'titulo');
    return i < 0 ? 0 : i;
  }

  function prepararPasos(html) {
    const pasos = quitarRubricas(agruparLecturasEnParrafos(parsearLiturgia(html)));
    marcarPiezasCantables(pasos);
    return pasos;
  }

  // -------------------------------------------------------------------
  // Frases de verdad, no renglones
  //
  // La fuente corta los salmos en renglones cortos por tipografía, no
  // por gramática: un mismo versículo puede venir partido en tres
  // líneas. Aquí se vuelven a pegar hasta encontrar un final de frase
  // real (punto, admiración, interrogación, puntos suspensivos, incluso
  // dentro de comillas o paréntesis). La coma, el punto y coma y los dos
  // puntos NO cortan: la voz les da su pausa natural dentro de la frase.
  // -------------------------------------------------------------------

  const RE_FIN_FRASE = /[.!?…][)\]"'»”’\s]*$/;
  const LARGO_MAX_FRASE = 700;

  function construirFrases(partes) {
    const frases = [];
    let actual = '';

    for (const cruda of partes) {
      const parte = String(cruda == null ? '' : cruda).trim();
      if (!parte) continue;

      actual = actual ? actual + ' ' + parte : parte;

      if (RE_FIN_FRASE.test(parte) || actual.length >= LARGO_MAX_FRASE) {
        frases.push(actual);
        actual = '';
      }
    }

    if (actual) frases.push(actual);
    return frases;
  }

  // Las referencias ("Del libro de Tobit 10, 8—11, 18", "(Salmo 64,
  // 14-15: CSEL 22, 245-246)") se ven en pantalla, pero un lector no las
  // dice en voz alta: dice "Del libro de Tobit". Además los modelos de
  // voz leen mal esos números sueltos. Esto solo cambia lo que se OYE.
  const RE_CITA_ENTRE_PARENTESIS = /\s*\((?=[^()]*(?:\d+\s*,\s*\d|\bcf\.))[^()]*\)/gi;
  const RE_REFERENCIA_AL_FINAL = /\s+\d+[a-z]?\s*,\s*\d+[a-z]?(?:\s*[-–—.,;:]\s*\d+[a-z]?)*\s*$/;

  function textoParaLeer(texto) {
    return String(texto == null ? '' : texto)
      .replace(RE_CITA_ENTRE_PARENTESIS, '')
      .replace(RE_REFERENCIA_AL_FINAL, '')
      .trim();
  }

  function frasesDelPaso(paso) {
    if (!paso) return [];
    if (paso.frases) return paso.frases;

    const partes = (paso.partes && paso.partes.length)
      ? paso.partes
      : String(paso.texto || '').split('\n');

    paso.frases = construirFrases(partes.map(textoParaLeer));
    return paso.frases;
  }

  // -------------------------------------------------------------------
  // Bloques: lo que de verdad se le manda al modelo de voz
  //
  // Un modelo neuronal decide la entonación mirando todo el texto que le
  // entra de una vez. Si se le mandan frases sueltas, cada una le llega
  // sin contexto y la lee como si fuera la única que existe — tono
  // plano, punto final en cada una. Por eso va el párrafo entero.
  // -------------------------------------------------------------------

  const LARGO_MAX_BLOQUE = 2500;

  function agruparEnBloques(frases) {
    const bloques = [];
    let actual = '';

    for (const frase of frases) {
      if (!actual) { actual = frase; continue; }
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

  function bloquesDelPaso(paso) {
    return agruparEnBloques(frasesDelPaso(paso));
  }

  // Los títulos no se leen en voz alta; todo lo demás sí.
  function pasoSeLee(paso) {
    return !!paso && paso.tipo !== 'titulo' && !!paso.texto;
  }

  // Todos los bloques de texto de una hora que necesitan audio, sin
  // repetidos. Es lo que el generador nocturno le pide a Fish Audio.
  function bloquesDeVoz(pasos) {
    const vistos = new Set();
    const bloques = [];

    for (const paso of pasos) {
      if (!pasoSeLee(paso)) continue;
      for (const b of bloquesDelPaso(paso)) {
        if (!vistos.has(b)) { vistos.add(b); bloques.push(b); }
      }
    }

    return bloques;
  }

  return {
    MESES, HORAS, REPO_BASE,
    construirCarpetaFecha, construirUrl, fechaISO, desdeISO,
    normalizarEspacios, detectarOpcionesDelDia, obtenerHTMLHora,
    extraerLineas, fusionarRuns, clasificarLinea, parsearLiturgia,
    agruparLecturasEnParrafos,
    RE_PIEZA, normalizarClave, marcarPiezasCantables, prepararPasos,
    quitarRubricas, primerPasoQueSeReza,
    RE_FIN_FRASE, LARGO_MAX_FRASE, construirFrases, textoParaLeer, frasesDelPaso,
    LARGO_MAX_BLOQUE, agruparEnBloques, bloquesDelPaso,
    pasoSeLee, bloquesDeVoz
  };
});
