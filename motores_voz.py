"""Motores de voz LOCALES de Modo Rezar: gratis, sin API, sin clave.

Todo corre en CPU, en el runner de GitHub Actions (4 núcleos, 16 GB) o
en cualquier computador. El mismo código sirve para dos cosas:

  probar   genera una muestra litúrgica con un motor y mide cuánto tarda
           (lo usa .github/workflows/probar-voces.yml)
  generar  genera el audio de una lista de bloques de texto
           (lo usa herramientas/generar-dia.js cada noche)

Así, lo que se escucha en la prueba es exactamente lo que después se
genera cada noche: mismo motor, misma voz, mismos parámetros.

Motores:
  supertonic        Supertonic 3, voz M4 (la recomendada). La más natural
                    de las ligeras: 3,65 de naturalidad (UTMOS) en bloques
                    reales de Laudes, contra 3,25 de Kokoro en los mismos.
  supertonic-XX     Otra voz de Supertonic (M1..M5 hombre, F1..F5 mujer).
  kokoro            Kokoro-82M, voz em_alex. Rápido; pronuncia bien el
                    español (probado: 2 % de error de palabra).
  qwen3-diseno      Qwen3-TTS 1.7B VoiceDesign: la voz se describe con
                    palabras (no copia a ninguna persona real).
  qwen3-clon        Qwen3-TTS 0.6B Base: repite la voz de una referencia.
  omnivoice-diseno  OmniVoice con atributos (hombre, mediana edad, grave).
  omnivoice-clon    OmniVoice repitiendo la voz de una referencia.
  chatterbox-clon   Chatterbox multilingüe (español) con referencia.

La referencia de los motores "clon" es la voz que diseña qwen3-diseno:
una voz sintética descrita con palabras, no la de una persona real.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import numpy as np

HILOS = int(os.environ.get("HILOS_VOZ", os.cpu_count() or 4))
os.environ.setdefault("OMP_NUM_THREADS", str(HILOS))

AQUI = os.path.dirname(os.path.abspath(__file__))
CACHE_MODELOS = os.environ.get("CACHE_MODELOS", os.path.join(os.path.expanduser("~"), ".cache", "modo-rezar"))

# Texto real de Laudes (25 de septiembre de 2026): el comienzo del
# Miserere y la lectura breve. Un salmo con comas y punto y coma, y una
# lectura en prosa: lo que más se escucha en la app.
MUESTRA_SALMO = (
    "Misericordia, Dios mío, por tu bondad; por tu inmensa compasión borra mi culpa; "
    "lava del todo mi delito, limpia mi pecado. Pues yo reconozco mi culpa, tengo "
    "siempre presente mi pecado: contra ti, contra ti solo pequé, cometí la maldad que "
    "aborreces. En la sentencia tendrás razón, en el juicio brillará tu rectitud. Mira, "
    "que en la culpa nací, pecador me concibió mi madre."
)
MUESTRA_LECTURA = (
    "No salga de vuestra boca palabra desedificante, sino la que sirva para la necesaria "
    "edificación, comunicando la gracia a los oyentes. Y no provoquéis más al santo "
    "Espíritu de Dios, con el cual fuisteis marcados para el día de la redención. "
    "Desterrad de entre vosotros todo exacerbamiento, animosidad, ira, pendencia, insulto "
    "y toda clase de maldad. Sed, por el contrario, bondadosos y compasivos unos con "
    "otros, y perdonaos mutuamente como también Dios os ha perdonado en Cristo."
)

# Frase de referencia para los motores que repiten una voz. Se conoce el
# texto exacto, que es lo que piden Qwen3 y OmniVoice para clonar bien.
REF_TEXTO = (
    "Dios mío, ven en mi auxilio. Señor, date prisa en socorrerme. "
    "Gloria al Padre, y al Hijo, y al Espíritu Santo."
)

DISENO_QWEN = (
    "Adult male voice, deep and warm, calm and reverent. Native Latin American Spanish "
    "speaker with a neutral accent, reading prayers aloud slowly and clearly, like a "
    "priest in a quiet chapel."
)
DISENO_OMNIVOICE = "male, middle-aged, low pitch"

SILENCIO_ENTRE_TROZOS = 0.35


def trocear(texto, maximo):
    """Parte un texto en trozos de hasta `maximo` caracteres, SOLO en
    finales de frase, lo más grandes posible (para no perder la
    entonación entre frases, que es lo que hace sonar natural)."""
    import re
    frases = re.split(r"(?<=[.!?…])\s+", texto.strip())
    trozos, actual = [], ""
    for f in frases:
        if not actual:
            actual = f
        elif len(actual) + 1 + len(f) <= maximo:
            actual += " " + f
        else:
            trozos.append(actual)
            actual = f
    if actual:
        trozos.append(actual)
    return trozos


def unir(audios, sr, silencio=SILENCIO_ENTRE_TROZOS):
    pausa = np.zeros(int(sr * silencio), dtype=np.float32)
    partes = []
    for i, a in enumerate(audios):
        if i:
            partes.append(pausa)
        partes.append(np.asarray(a, dtype=np.float32).reshape(-1))
    return np.concatenate(partes) if partes else np.zeros(0, dtype=np.float32)


def bajar(url, destino):
    if os.path.exists(destino) and os.path.getsize(destino) > 0:
        return destino
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    tmp = destino + ".part"
    print(f"  bajando {os.path.basename(destino)}…", flush=True)
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, destino)
    return destino


def guardar_mp3(audio, sr, ruta, kbps=64):
    import soundfile as sf
    os.makedirs(os.path.dirname(os.path.abspath(ruta)) or ".", exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        wav = t.name
    # Se escribe aparte y se renombra al final: si el proceso se corta a
    # mitad (p. ej. el límite de tiempo del runner), no queda en la caché
    # un mp3 a medias que se reutilizaría para siempre.
    parcial = ruta + ".part.mp3"
    try:
        sf.write(wav, np.asarray(audio, dtype=np.float32), sr)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-b:a", f"{kbps}k", parcial],
            check=True,
        )
        os.replace(parcial, ruta)
    finally:
        os.remove(wav)
        if os.path.exists(parcial):
            os.remove(parcial)


def fijar_semilla():
    try:
        import torch
        torch.manual_seed(1234)
        torch.set_num_threads(HILOS)
    except ImportError:
        pass
    np.random.seed(1234)


# ---------------------------------------------------------------------
# Motores
# ---------------------------------------------------------------------

SEMILLAS = (1234, 2025, 777, 42, 3141)
# Pausa al volver a unir un trozo que hubo que leer en dos mitades: la de
# fin de frase si se partió en un punto; más corta si fue en una coma.
PAUSA_MITAD_FRASE = 0.12


def partir_en_dos(texto):
    """Parte un texto en dos mitades por el corte natural más cercano al
    centro: fin de frase; si no hay, punto y coma o dos puntos; si no,
    coma. Devuelve (primera, segunda, pausa) o None si no hay dónde."""
    import re
    medio = len(texto) / 2
    for patron, pausa in ((r"(?<=[.!?…])\s+", SILENCIO_ENTRE_TROZOS),
                          (r"(?<=[;:])\s+", PAUSA_MITAD_FRASE),
                          (r"(?<=,)\s+", PAUSA_MITAD_FRASE)):
        cortes = [m for m in re.finditer(patron, texto)
                  if m.start() >= 20 and len(texto) - m.end() >= 20]
        if cortes:
            c = min(cortes, key=lambda m: abs(m.start() - medio))
            return texto[:c.start()].strip(), texto[c.end():].strip(), pausa
    return None


class Motor:
    nombre = ""
    descripcion = ""
    licencia = ""
    maximo_trozo = 2500          # caracteres por llamada al modelo
    necesita_referencia = False
    # Los motores "estocásticos" pueden salir distinto en cada intento
    # (y a veces comerse palabras): a esos se les verifica cada trozo y,
    # si falla, se reintenta con otra semilla.
    estocastico = False

    def __init__(self):
        self.estadisticas = {"trozos": 0, "reintentos": 0, "con_dudas": 0, "palabras": 0, "distintas": 0}

    def clave(self):
        """Identifica motor + voz + ajustes. Entra en el nombre de cada
        mp3, así que cambiar de voz nunca reutiliza audio de otra."""
        return self.nombre

    def cargar(self, referencia=None):
        raise NotImplementedError

    def _generar_trozo(self, texto, semilla=None):
        raise NotImplementedError

    def generar(self, texto, verificador=None):
        trozos = trocear(texto, self.maximo_trozo)
        if not trozos:
            raise ValueError("texto vacío")
        audios, sr = [], None
        for t in trozos:
            a, sr = self._trozo_verificado(t, verificador)
            audios.append(a)
        return unir(audios, sr), sr

    def _trozo_verificado(self, texto, verificador):
        self.estadisticas["trozos"] += 1
        intentos = SEMILLAS if (verificador and self.estocastico) else SEMILLAS[:1]
        mejor = None
        for n, semilla in enumerate(intentos):
            if n:
                self.estadisticas["reintentos"] += 1
            audio, sr = self._generar_trozo(texto, semilla)
            if not verificador:
                return audio, sr
            ok, puntaje = verificador.revisar(texto, audio, sr)
            if mejor is None or puntaje < mejor[2]:
                mejor = (audio, sr, puntaje, dict(verificador.ultimo))
            if ok:
                break
        else:
            # Ningún intento pasó. Si es porque se come palabras, casi
            # siempre se arregla leyéndolo en dos mitades: con menos texto
            # de una vez, el modelo no se salta nada.
            mitades = partir_en_dos(texto) if mejor[3]["salto"] >= 2 else None
            if mitades:
                self.estadisticas["partidos"] = self.estadisticas.get("partidos", 0) + 1
                print(f"  · se comía palabras; se lee en dos partes: «{texto[:60]}…»", flush=True)
                a1, sr = self._trozo_verificado(mitades[0], verificador)
                a2, _ = self._trozo_verificado(mitades[1], verificador)
                return unir([a1, a2], sr, mitades[2]), sr
            # Si no, se queda el menos malo.
            self.estadisticas["con_dudas"] += 1
            print(f"  ! trozo con dudas tras {len(intentos)} intentos: «{texto[:70]}…»", flush=True)
        self.estadisticas["palabras"] += mejor[3]["palabras"]
        self.estadisticas["distintas"] += mejor[3]["distintas"]
        return mejor[0], mejor[1]


class Kokoro(Motor):
    nombre = "kokoro"
    descripcion = "Kokoro-82M · em_alex (hombre)"
    licencia = "Apache-2.0"
    BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

    def __init__(self, voz="em_alex"):
        super().__init__()
        self.voz = voz

    def clave(self):
        return f"kokoro-v1.0:{self.voz}"

    def cargar(self, referencia=None):
        from kokoro_onnx import Kokoro as K
        modelo = bajar(f"{self.BASE}/kokoro-v1.0.onnx", os.path.join(CACHE_MODELOS, "kokoro-v1.0.onnx"))
        voces = bajar(f"{self.BASE}/voices-v1.0.bin", os.path.join(CACHE_MODELOS, "voices-v1.0.bin"))
        self.k = K(modelo, voces)

    def _generar_trozo(self, texto, semilla=None):
        return self.k.create(texto, voice=self.voz, speed=1.0, lang="es")


def sembrar(semilla):
    if semilla is None:
        return
    try:
        import torch
        torch.manual_seed(semilla)
    except ImportError:
        pass
    np.random.seed(semilla)


def con_idioma(llamar):
    """Qwen3 valida el idioma contra la lista de su modelo. Se pide
    "Spanish"; si esa lista lo nombrara distinto, se usa "Auto" (detecta
    el idioma del texto) en vez de fallar."""
    try:
        return llamar("Spanish")
    except ValueError as e:
        if "language" not in str(e).lower():
            raise
        print("  (Qwen3 no reconoce 'Spanish'; se usa 'Auto')", flush=True)
        return llamar("Auto")


class Qwen3Diseno(Motor):
    estocastico = True
    nombre = "qwen3-diseno"
    descripcion = "Qwen3-TTS 1.7B · voz diseñada con palabras"
    licencia = "Apache-2.0"
    maximo_trozo = 900

    def clave(self):
        return "qwen3-1.7b-diseno:" + DISENO_QWEN

    def cargar(self, referencia=None):
        import torch
        from qwen_tts import Qwen3TTSModel
        self.m = Qwen3TTSModel.from_pretrained(
            "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cpu", dtype=torch.float32)

    def _generar_trozo(self, texto, semilla=None):
        sembrar(semilla)
        wavs, sr = con_idioma(lambda idioma: self.m.generate_voice_design(
            text=texto, instruct=DISENO_QWEN, language=idioma))
        return wavs[0], sr


class Qwen3Clon(Motor):
    estocastico = True
    nombre = "qwen3-clon"
    descripcion = "Qwen3-TTS 0.6B · repite la voz de referencia"
    licencia = "Apache-2.0"
    maximo_trozo = 900
    necesita_referencia = True

    def clave(self):
        return "qwen3-0.6b-clon:" + self.huella

    def cargar(self, referencia=None):
        import torch
        from qwen_tts import Qwen3TTSModel
        self.ref_audio, self.ref_texto = referencia
        self.huella = huella_archivo(self.ref_audio)
        self.m = Qwen3TTSModel.from_pretrained(
            "Qwen/Qwen3-TTS-12Hz-0.6B-Base", device_map="cpu", dtype=torch.float32)
        self.prompt = self.m.create_voice_clone_prompt(ref_audio=self.ref_audio, ref_text=self.ref_texto)

    def _generar_trozo(self, texto, semilla=None):
        sembrar(semilla)
        wavs, sr = con_idioma(lambda idioma: self.m.generate_voice_clone(
            text=texto, language=idioma, voice_clone_prompt=self.prompt))
        return wavs[0], sr


class OmniVoiceDiseno(Motor):
    estocastico = True
    nombre = "omnivoice-diseno"
    descripcion = "OmniVoice · hombre, mediana edad, voz grave"
    licencia = "Apache-2.0"
    maximo_trozo = 600

    def clave(self):
        return "omnivoice-diseno:" + DISENO_OMNIVOICE

    def cargar(self, referencia=None):
        import torch
        from omnivoice import OmniVoice
        self.m = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cpu", dtype=torch.float32)

    def _generar_trozo(self, texto, semilla=None):
        sembrar(semilla)
        return self.m.generate(text=texto, language="Spanish", instruct=DISENO_OMNIVOICE)[0], 24000


class OmniVoiceClon(Motor):
    estocastico = True
    nombre = "omnivoice-clon"
    descripcion = "OmniVoice · repite la voz de referencia"
    licencia = "Apache-2.0"
    maximo_trozo = 600
    necesita_referencia = True

    def clave(self):
        return "omnivoice-clon:" + self.huella

    def cargar(self, referencia=None):
        import torch
        from omnivoice import OmniVoice
        self.ref_audio, self.ref_texto = referencia
        self.huella = huella_archivo(self.ref_audio)
        self.m = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cpu", dtype=torch.float32)

    def _generar_trozo(self, texto, semilla=None):
        sembrar(semilla)
        # Con ref_text explícito no hace falta cargar Whisper para
        # transcribir la referencia.
        return self.m.generate(text=texto, language="Spanish",
                               ref_audio=self.ref_audio, ref_text=self.ref_texto)[0], 24000


class ChatterboxClon(Motor):
    estocastico = True
    nombre = "chatterbox-clon"
    descripcion = "Chatterbox multilingüe · repite la voz de referencia"
    licencia = "MIT (añade una marca de agua inaudible)"
    maximo_trozo = 350   # el modelo corta a ~40 s por llamada
    necesita_referencia = True

    def clave(self):
        return "chatterbox-mtl-clon:" + self.huella

    def cargar(self, referencia=None):
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        self.ref_audio, self.ref_texto = referencia
        self.huella = huella_archivo(self.ref_audio)
        self.m = ChatterboxMultilingualTTS.from_pretrained(device="cpu")
        self.m.prepare_conditionals(self.ref_audio)

    def _generar_trozo(self, texto, semilla=None):
        sembrar(semilla)
        wav = self.m.generate(texto, language_id="es")
        return wav.squeeze(0).cpu().numpy(), self.m.sr


class Supertonic(Motor):
    """Supertonic 3 (Supertone), exportado a ONNX por sherpa-onnx.

    Es el más natural de los que corren ligeros en CPU: medido con UTMOS
    (naturalidad 1-5) sobre texto litúrgico real, la voz M4 sacó 3,79
    contra 3,37 de Kokoro em_alex. El punto óptimo son 16 pasos de
    refinamiento: con 5 baja a 3,2 y con 32 ya no mejora.

    Como a veces se come palabras (lo documenta el propio proyecto, y
    pasó en las pruebas), cada trozo se verifica y se reintenta.
    """
    licencia = "OpenRAIL-M (modelo) · MIT (código)"
    maximo_trozo = 300   # lo mismo que usa el modelo por dentro; salió mejor que trozos largos
    estocastico = True
    PAQUETE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
    URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{PAQUETE}.tar.bz2"
    # voice.bin se arma con los json ordenados: F1..F5 y luego M1..M5
    VOCES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]

    def __init__(self, voz="M4", pasos=16):
        super().__init__()
        self.voz = voz
        self.pasos = pasos
        self.nombre = "supertonic" if voz == "M4" else f"supertonic-{voz}"
        genero = "hombre" if voz.startswith("M") else "mujer"
        self.descripcion = f"Supertonic 3 · {voz} ({genero}, {pasos} pasos)"

    def clave(self):
        return f"supertonic-3-int8:{self.voz}:p{self.pasos}"

    def cargar(self, referencia=None):
        import tarfile
        import sherpa_onnx as so
        d = os.path.join(CACHE_MODELOS, self.PAQUETE)
        if not os.path.exists(os.path.join(d, "voice.bin")):
            tar = bajar(self.URL, os.path.join(CACHE_MODELOS, self.PAQUETE + ".tar.bz2"))
            with tarfile.open(tar) as t:
                t.extractall(CACHE_MODELOS)
            os.remove(tar)
        cfg = so.OfflineTtsConfig(model=so.OfflineTtsModelConfig(
            supertonic=so.OfflineTtsSupertonicModelConfig(
                duration_predictor=f"{d}/duration_predictor.int8.onnx",
                text_encoder=f"{d}/text_encoder.int8.onnx",
                vector_estimator=f"{d}/vector_estimator.int8.onnx",
                vocoder=f"{d}/vocoder.int8.onnx",
                tts_json=f"{d}/tts.json",
                unicode_indexer=f"{d}/unicode_indexer.bin",
                voice_style=f"{d}/voice.bin"),
            num_threads=HILOS, provider="cpu"))
        self.so = so
        self.tts = so.OfflineTts(cfg)
        self.sid = self.VOCES.index(self.voz)

    def _generar_trozo(self, texto, semilla=None):
        g = self.so.GenerationConfig()
        g.sid = self.sid
        g.speed = 1.0
        g.num_steps = self.pasos
        # max_len alto: el troceo ya lo hace trocear(), en finales de frase.
        g.extra = {"lang": "es", "max_len": "1000", "seed": str(semilla or SEMILLAS[0])}
        a = self.tts.generate(texto, g)
        return np.asarray(a.samples, dtype=np.float32), a.sample_rate


class Verificador:
    """Transcribe cada trozo con Whisper (small, en CPU, vía sherpa-onnx)
    y lo compara con el texto. Rechaza el trozo si faltan 2 o más
    palabras seguidas (el síntoma de un salto) o si demasiadas palabras
    no coinciden. Los trozos muy cortos solo se revisan por saltos: en
    "Amén." Whisper a veces escribe "Améns", y eso no es un fallo."""

    URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2"

    def __init__(self):
        import tarfile
        import sherpa_onnx as so
        d = os.path.join(CACHE_MODELOS, "sherpa-onnx-whisper-small")
        if not os.path.exists(os.path.join(d, "small-decoder.int8.onnx")):
            tar = bajar(self.URL, os.path.join(CACHE_MODELOS, "whisper-small.tar.bz2"))
            with tarfile.open(tar) as t:
                miembros = [m for m in t.getmembers() if m.name.endswith((".int8.onnx", "tokens.txt"))]
                t.extractall(CACHE_MODELOS, members=miembros)
            os.remove(tar)
        self.rec = so.OfflineRecognizer.from_whisper(
            encoder=f"{d}/small-encoder.int8.onnx", decoder=f"{d}/small-decoder.int8.onnx",
            tokens=f"{d}/small-tokens.txt", language="es", task="transcribe", num_threads=HILOS)

    @staticmethod
    def _palabras(t):
        import re
        import unicodedata
        t = unicodedata.normalize("NFD", t.lower())
        t = "".join(c for c in t if unicodedata.category(c) != "Mn")
        return re.sub(r"[^a-zñ0-9 ]+", " ", t).split()

    @staticmethod
    def _cortes_en_silencio(audio, sr, maximo=24.0):
        """Whisper trabaja en ventanas de 30 s. Si el audio es más largo,
        se corta en el momento más silencioso cerca de cada límite, para
        no partir una palabra por la mitad (partirla hacía que Whisper la
        perdiera y pareciera que la voz se la había saltado)."""
        audio = np.asarray(audio, dtype=np.float32)
        cortes, inicio, n = [], 0, len(audio)
        marco = max(1, int(sr * 0.05))
        while n - inicio > maximo * sr:
            desde = inicio + int((maximo - 6) * sr)
            hasta = min(n, inicio + int(maximo * sr))
            tramo = audio[desde:hasta]
            energias = [float(np.mean(tramo[k:k + marco] ** 2)) for k in range(0, len(tramo) - marco, marco)]
            k = int(np.argmin(energias)) if energias else len(tramo) // 2
            corte = desde + k * marco + marco // 2
            cortes.append((inicio, corte))
            inicio = corte
        cortes.append((inicio, n))
        return cortes

    def transcribir(self, audio, sr):
        partes = []
        for a, b in self._cortes_en_silencio(audio, sr):
            st = self.rec.create_stream()
            st.accept_waveform(sr, np.asarray(audio[a:b], dtype=np.float32))
            self.rec.decode_stream(st)
            partes.append(st.result.text)
        return " ".join(partes)

    def revisar(self, texto, audio, sr):
        """Devuelve (aceptado, puntaje); menor puntaje = mejor."""
        import difflib
        esperado = self._palabras(texto)
        oido = self._palabras(self.transcribir(audio, sr))
        salto = 0
        distintas = 0
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, esperado, oido).get_opcodes():
            if op == "equal":
                continue
            distintas += max(i2 - i1, j2 - j1)
            if op == "delete" or (op == "replace" and (i2 - i1) - (j2 - j1) >= 2):
                salto = max(salto, (i2 - i1) - (j2 - j1))
        error = distintas / max(1, len(esperado))
        self.ultimo = {"palabras": len(esperado), "distintas": distintas, "salto": salto}
        corto = len(esperado) < 6
        aceptado = salto < 2 and (corto or error <= 0.25)
        return aceptado, salto * 10 + error


MOTORES = {
    "kokoro": Kokoro,
    "qwen3-diseno": Qwen3Diseno,
    "qwen3-clon": Qwen3Clon,
    "omnivoice-diseno": OmniVoiceDiseno,
    "omnivoice-clon": OmniVoiceClon,
    "chatterbox-clon": ChatterboxClon,
    "supertonic": Supertonic,                      # voz M4, la recomendada
}
for _v in Supertonic.VOCES:
    MOTORES[f"supertonic-{_v}"] = (lambda v: (lambda: Supertonic(voz=v)))(_v)


def huella_archivo(ruta):
    import hashlib
    with open(ruta, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:12]


def referencia_de_respaldo(carpeta):
    """Si no hay voz de referencia (el diseño con Qwen3 falló), se usa
    una frase de Kokoro, que siempre está disponible. Clonará peor, pero
    la prueba no se queda sin muestras."""
    ruta = os.path.join(carpeta, "referencia-kokoro.wav")
    if not os.path.exists(ruta):
        import soundfile as sf
        k = Kokoro()
        k.cargar()
        audio, sr = k._generar_trozo(REF_TEXTO)
        sf.write(ruta, audio, sr)
    return ruta, REF_TEXTO


class Naturalidad:
    """Nota de naturalidad con UTMOS (1 = robótica, 5 = humana): un modelo
    entrenado para predecir cómo califican personas las voces sintéticas.
    Se entrenó sobre todo con inglés, así que sirve para comparar voces
    entre sí, no como nota absoluta. Código y pesos: tarepan/SpeechMOS
    (MIT), todo desde GitHub."""

    RAW = "https://raw.githubusercontent.com/tarepan/SpeechMOS/v1.2.0/"
    PESOS = "https://github.com/tarepan/SpeechMOS/releases/download/v1.0.0/utmos22_strong_step7459_v1.pt"

    def __init__(self):
        import torch
        base = os.path.join(CACHE_MODELOS, "speechmos")
        for f in ("speechmos/utmos22/fairseq_alt.py", "speechmos/utmos22/strong/model.py"):
            bajar(self.RAW + f, os.path.join(base, f))
        for f in ("speechmos/__init__.py", "speechmos/utmos22/__init__.py", "speechmos/utmos22/strong/__init__.py"):
            open(os.path.join(base, f), "a").close()
        sys.path.insert(0, base)
        from speechmos.utmos22.strong.model import UTMOS22Strong
        self.torch = torch
        self.m = UTMOS22Strong()
        self.m.load_state_dict(torch.load(bajar(self.PESOS, os.path.join(CACHE_MODELOS, "utmos22_strong.pt")),
                                          map_location="cpu"))
        self.m.eval()

    def nota(self, ruta_audio):
        pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", ruta_audio, "-f", "s16le", "-ac", "1",
                              "-ar", "16000", "-"], check=True, capture_output=True).stdout
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        notas = []
        with self.torch.inference_mode():
            for i in range(0, len(audio), 16000 * 10):   # tramos de 10 s, como mejor funciona
                t = audio[i:i + 16000 * 10]
                if len(t) >= 16000 * 3:
                    notas.append(float(self.m(self.torch.from_numpy(t).unsqueeze(0), 16000)[0]))
        return round(float(np.mean(notas)), 2) if notas else None


# ---------------------------------------------------------------------
# Comandos
# ---------------------------------------------------------------------

def cmd_probar(args):
    fijar_semilla()
    os.makedirs(args.salida, exist_ok=True)
    motor = MOTORES[args.motor]()

    referencia = None
    if motor.necesita_referencia:
        if args.ref and os.path.exists(args.ref):
            texto_ref = open(args.ref_texto, encoding="utf-8").read().strip() if args.ref_texto else REF_TEXTO
            referencia = (args.ref, texto_ref)
        else:
            print("  sin referencia de Qwen3: se usa una de Kokoro", flush=True)
            referencia = referencia_de_respaldo(args.salida)

    t0 = time.time()
    motor.cargar(referencia)
    carga = time.time() - t0
    print(f"  {motor.nombre}: modelo cargado en {carga:.1f} s", flush=True)

    # La muestra pasa por la MISMA verificación que el audio de cada noche:
    # cada trozo se transcribe con Whisper y se reintenta si se comió
    # palabras. Además deja medido cuántas palabras salen mal.
    verificador = Verificador() if args.verificar else None

    t0 = time.time()
    a1, sr = motor.generar(MUESTRA_SALMO, verificador)
    a2, sr2 = motor.generar(MUESTRA_LECTURA, verificador)
    generando = time.time() - t0
    audio = unir([a1, a2], sr, silencio=0.9)
    segundos = len(audio) / sr

    guardar_mp3(audio, sr, os.path.join(args.salida, motor.nombre + ".mp3"), kbps=96)
    datos = {
        "motor": motor.nombre,
        "descripcion": motor.descripcion,
        "licencia": motor.licencia,
        "hilos": HILOS,
        "segundos_carga": round(carga, 1),
        "segundos_generando": round(generando, 1),
        "segundos_audio": round(segundos, 1),
        "rtf": round(generando / segundos, 3),
        "verificacion": dict(motor.estadisticas) if verificador else None,
    }
    if verificador and motor.estadisticas["palabras"]:
        # Medido trozo por trozo, sin los cortes de ventana de Whisper.
        datos["palabras_mal"] = round(motor.estadisticas["distintas"] / motor.estadisticas["palabras"], 3)
    json.dump(datos, open(os.path.join(args.salida, motor.nombre + ".json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"  {motor.nombre}: {segundos:.1f} s de audio en {generando:.1f} s (RTF {datos['rtf']})", flush=True)

    # El diseño de Qwen3 deja además la voz de referencia para los demás.
    if motor.nombre == "qwen3-diseno":
        import soundfile as sf
        ref, sr_ref = motor._generar_trozo(REF_TEXTO)
        sf.write(os.path.join(args.salida, "referencia.wav"), np.asarray(ref, dtype=np.float32), sr_ref)
        open(os.path.join(args.salida, "referencia.txt"), "w", encoding="utf-8").write(REF_TEXTO)
        print("  referencia.wav lista para los motores que clonan", flush=True)


def cmd_generar(args):
    """Genera los mp3 que faltan de una lista [{texto, archivo}, ...]."""
    fijar_semilla()
    lista = json.load(open(args.lista, encoding="utf-8"))
    pendientes = [x for x in lista if not os.path.exists(x["archivo"])]
    if not pendientes:
        print("  nada que generar: todo está en caché", flush=True)
        return

    motor = MOTORES[args.motor]()
    referencia = None
    if motor.necesita_referencia:
        if not args.ref or not os.path.exists(args.ref):
            sys.exit(f"El motor {motor.nombre} necesita --ref con la voz de referencia.")
        texto_ref = open(args.ref_texto, encoding="utf-8").read().strip() if args.ref_texto else REF_TEXTO
        referencia = (args.ref, texto_ref)
    motor.cargar(referencia)

    verificador = None
    if motor.estocastico and not args.sin_verificar:
        print("  verificación activada: cada trozo se transcribe con Whisper", flush=True)
        verificador = Verificador()

    t0 = time.time()
    total_audio = 0.0
    fallidos = 0
    for i, x in enumerate(pendientes, 1):
        try:
            audio, sr = motor.generar(x["texto"], verificador)
            guardar_mp3(audio, sr, x["archivo"], kbps=64)
            total_audio += len(audio) / sr
        except Exception as e:  # un bloque que falla no tumba el día
            fallidos += 1
            print(f"  ! bloque {i} falló: {e}", flush=True)
        if i % 10 == 0 or i == len(pendientes):
            print(f"  {i}/{len(pendientes)} bloques · {total_audio/60:.1f} min de audio · "
                  f"{(time.time()-t0)/60:.1f} min generando", flush=True)
    if fallidos:
        print(f"  {fallidos} bloques fallidos (la app los leerá con la voz del sistema)", flush=True)
    e = motor.estadisticas
    if verificador:
        print(f"  verificación: {e['trozos']} trozos, {e['reintentos']} reintentos, "
              f"{e.get('partidos', 0)} leídos en dos partes, "
              f"{e['con_dudas']} con dudas tras {len(SEMILLAS)} intentos", flush=True)


def cmd_clave(args):
    """Imprime la clave de caché del motor (la usa generar-dia.js para
    nombrar los archivos). Para los que clonan depende de la referencia."""
    motor = MOTORES[args.motor]()
    if motor.necesita_referencia:
        motor.huella = huella_archivo(args.ref)
    print(motor.clave())


def cmd_informe(args):
    """Junta las muestras de todos los motores en una página para
    escucharlas lado a lado, ordenadas por naturalidad."""
    import html
    import shutil
    os.makedirs(args.salida, exist_ok=True)
    filas = []
    for raiz, _, archivos in os.walk(args.entrada):
        for a in archivos:
            if a.endswith(".json") and not a.startswith("resultados"):
                try:
                    d = json.load(open(os.path.join(raiz, a), encoding="utf-8"))
                except Exception:
                    continue
                mp3 = os.path.join(raiz, d.get("motor", "") + ".mp3")
                if "rtf" in d and os.path.exists(mp3):
                    destino = os.path.join(args.salida, os.path.basename(mp3))
                    shutil.copy(mp3, destino)
                    d["_mp3"] = destino
                    filas.append(d)

    if args.naturalidad and filas:
        print("  calculando naturalidad (UTMOS)…", flush=True)
        n = Naturalidad()
        for d in filas:
            d["naturalidad"] = n.nota(d["_mp3"])
            print(f"    {d['motor']:<20} {d['naturalidad']}", flush=True)

    filas.sort(key=lambda d: (-(d.get("naturalidad") or 0), d["rtf"]))

    # Minutos de audio NUEVO por noche, una vez caliente la caché (medido
    # sobre 4 semanas reales: ~40 % de un día de ~30 min es texto nuevo).
    # La verificación con Whisper suma más o menos lo mismo que generar.
    NUEVO_MIN = 12.0
    celdas = []
    for i, d in enumerate(filas):
        verifica = d.get("verificacion") is not None
        minutos = d["rtf"] * NUEVO_MIN
        cabe = "cabe de sobra" if minutos < 90 else ("cabe" if minutos < 240 else "no cabe en 6 h")
        nat = d.get("naturalidad")
        nat_txt = f"<b>{nat:.2f}</b>" if nat is not None else "—"
        mal = d.get("palabras_mal")
        mal_txt = f"{mal * 100:.1f} %" if mal is not None else "—"
        clase = " class='mejor'" if i == 0 and nat is not None else ""
        celdas.append(
            "<tr{}><td><b>{}</b><br><small>{}</small></td><td>{}</td><td>{}</td><td>{:.0f} min<br><small>{}</small></td>"
            "<td><audio controls preload='none' src='{}'></audio></td></tr>".format(
                clase, html.escape(d["descripcion"]), html.escape(d["licencia"]), nat_txt, mal_txt,
                minutos, cabe + (" · verificada" if verifica else ""), html.escape(os.path.basename(d["_mp3"]))))

    pagina = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voces para Modo Rezar</title>
<style>
:root{{--papel:#f6f0e3;--tinta:#241f18;--suave:#6b6253;--rubrica:#8a1c1c;--linea:#ddd1bb}}
@media (prefers-color-scheme: dark){{:root{{--papel:#1b1814;--tinta:#efe7d8;--suave:#b3a78f;--rubrica:#e0736a;--linea:#3a332a}}}}
body{{font-family:Georgia,serif;max-width:960px;margin:2rem auto;padding:0 16px;color:var(--tinta);background:var(--papel)}}
h1{{font-weight:500}} table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid var(--linea);padding:10px 6px;text-align:left;vertical-align:middle}}
th{{font-size:13px;color:var(--suave);font-weight:400;text-transform:uppercase;letter-spacing:.04em}}
tr.mejor td{{background:color-mix(in srgb, var(--rubrica) 8%, transparent)}}
small{{color:var(--suave)}} audio{{width:240px;max-width:100%}}
details{{margin:1rem 0;color:var(--suave)}} .tabla{{overflow-x:auto}}
</style></head><body>
<h1>Voces para Modo Rezar</h1>
<p>Todas leen el mismo texto, en el mismo runner de GitHub ({filas[0]['hilos'] if filas else 4} núcleos, sin GPU),
ordenadas de la más natural a la menos. Escúchalas: la nota ayuda, pero decide el oído.</p>
<details><summary>Texto que leen</summary><p>{html.escape(MUESTRA_SALMO)}</p><p>{html.escape(MUESTRA_LECTURA)}</p></details>
<div class="tabla"><table><tr><th>Voz</th><th>Naturalidad</th><th>Palabras mal</th><th>Por noche</th><th>Escuchar</th></tr>
{''.join(celdas)}
</table></div>
<p><small><b>Naturalidad</b>: nota de UTMOS (1 = robótica, 5 = humana), un modelo entrenado para imitar cómo
califican personas las voces sintéticas; entrenado sobre todo con inglés, sirve para comparar estas voces
entre sí. Como referencia, en las pruebas Kokoro sacó 3,25–3,37 y Supertonic M4 3,65–3,79.
<b>Palabras mal</b>: transcribiendo cada trozo con Whisper y comparando con el texto (parte son errores del
propio Whisper). <b>Por noche</b>: lo que tardaría en generar los ~12 minutos de audio nuevo de cada día; el
límite de GitHub son 6 horas. Qwen3 y OmniVoice "diseño" pueden variar la voz de un bloque a otro: para uso
diario se usa su versión "clon", que repite siempre la voz de referencia.</small></p>
</body></html>"""
    open(os.path.join(args.salida, "comparacion.html"), "w", encoding="utf-8").write(pagina)
    print(f"  comparacion.html con {len(filas)} voces", flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="comando", required=True)

    a = sub.add_parser("probar")
    a.add_argument("--motor", required=True, choices=MOTORES)
    a.add_argument("--salida", default="muestras")
    a.add_argument("--ref")
    a.add_argument("--ref-texto")
    a.add_argument("--verificar", action="store_true",
                   help="verificar cada trozo con Whisper, como cada noche, y medir palabras mal")
    a.set_defaults(fn=cmd_probar)

    g = sub.add_parser("generar")
    g.add_argument("--motor", required=True, choices=MOTORES)
    g.add_argument("--lista", required=True)
    g.add_argument("--ref")
    g.add_argument("--ref-texto")
    g.add_argument("--sin-verificar", action="store_true",
                   help="no transcribir cada trozo para detectar palabras saltadas")
    g.set_defaults(fn=cmd_generar)

    c = sub.add_parser("clave")
    c.add_argument("--motor", required=True, choices=MOTORES)
    c.add_argument("--ref")
    c.set_defaults(fn=cmd_clave)

    i = sub.add_parser("informe")
    i.add_argument("--entrada", required=True)
    i.add_argument("--salida", required=True)
    i.add_argument("--naturalidad", action="store_true", help="puntuar cada voz con UTMOS")
    i.set_defaults(fn=cmd_informe)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
