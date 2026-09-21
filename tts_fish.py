"""
Generación de voz con Fish Audio para Modo Rezar.

Uso (la clave NUNCA va escrita aquí dentro):

    export FISH_API_KEY="AQUI_VA_LA_API_KEY"
    pip install httpx
    python3 tts_fish.py "Hermanos míos, mantengamos firme nuestra confianza."

o desde otro script:

    from tts_fish import text_to_speech
    text_to_speech("Texto a leer", "audios/mi-audio.mp3")

Esto sirve para generar audios de antemano (por ejemplo, un texto fijo
que quieras dejar empaquetado dentro de la app). La app web llama a la
misma API por su cuenta desde el navegador — ver voz-fish.js.

Reglas fijas: siempre se usa reference_id = 8d2c17a9b26d4d83888ea67a1ee565b2.
No se sustituye por otra voz, no se elige una parecida, no se clona una
voz nueva, no se descarga ningún checkpoint y no hace falta instalar Fish
Speech en el computador.
"""

import os
import sys

import httpx

VOICE_ID = "8d2c17a9b26d4d83888ea67a1ee565b2"
MODEL = "s2.1-pro-free"
FORMAT = "mp3"

API_URL = "https://api.fish.audio/v1/tts"

VOZ_NO_DISPONIBLE = f"La voz {VOICE_ID} no está disponible para esta llamada."


def text_to_speech(text, output_path="output.mp3"):
    """Convierte `text` en audio con la voz fija y lo guarda como MP3.

    Devuelve la ruta del archivo generado.
    """
    if not text or not text.strip():
        raise ValueError("El texto está vacío: no hay nada que leer.")

    api_key = os.environ.get("FISH_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Falta la variable de entorno FISH_API_KEY. "
            'Defínela con: export FISH_API_KEY="tu-clave"'
        )

    payload = {
        "text": text,
        "reference_id": VOICE_ID,
        "format": FORMAT,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "model": MODEL,
    }

    with httpx.Client(timeout=120.0) as client:
        respuesta = client.post(API_URL, json=payload, headers=headers)

    if respuesta.status_code in (401, 403):
        # Nunca se imprime la clave, solo el hecho de que fue rechazada.
        raise RuntimeError("Fish Audio rechazó la clave de API (FISH_API_KEY).")

    if respuesta.status_code == 402:
        raise RuntimeError("La cuenta de Fish Audio no tiene saldo o cuota disponible.")

    if respuesta.status_code == 404 or (
        respuesta.status_code >= 400
        and any(
            palabra in respuesta.text.lower()
            for palabra in ("reference", "voice", "model")
        )
    ):
        # No se sustituye la voz por ninguna otra: se informa tal cual,
        # conservando el ID original para diagnóstico.
        raise RuntimeError(VOZ_NO_DISPONIBLE)

    if respuesta.status_code != 200:
        raise RuntimeError(
            f"Fish Audio respondió con un error {respuesta.status_code}."
        )

    audio = respuesta.content
    if not audio:
        raise RuntimeError("Fish Audio devolvió un audio vacío.")

    carpeta = os.path.dirname(os.path.abspath(output_path))
    if carpeta:
        os.makedirs(carpeta, exist_ok=True)

    with open(output_path, "wb") as f:
        f.write(audio)

    return output_path


if __name__ == "__main__":
    texto = " ".join(sys.argv[1:]).strip()
    if not texto:
        texto = (
            "Hermanos míos, mantengamos firme nuestra confianza "
            "en estos tiempos difíciles."
        )

    destino = text_to_speech(texto, "output.mp3")
    print(f"Listo: {destino}")
