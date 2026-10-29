"""Adaptadores do MediaPipe Face Landmarker para os modos vídeo e ao vivo."""

import threading
import time

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python import vision

from entrada.confianca import ParametrosConfianca
from entrada.contrato import RAIZ, RegistroMetricas
from entrada.metricas import CalculadoraMetricas, pontos_em_pixels


def _opcoes(config: dict, modo, callback=None) -> vision.FaceLandmarkerOptions:
    mpc = config["mediapipe"]
    return vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(RAIZ / mpc["modelo"])),
        running_mode=modo,
        num_faces=1,
        min_face_detection_confidence=mpc["min_confianca_deteccao"],
        min_face_presence_confidence=mpc["min_confianca_presenca"],
        min_tracking_confidence=mpc["min_confianca_rastreio"],
        output_facial_transformation_matrixes=True,
        result_callback=callback,
    )


def _imagem(quadro_bgr) -> mp.Image:
    rgb = cv2.cvtColor(quadro_bgr, cv2.COLOR_BGR2RGB)
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)


def _pontos_e_matriz(resultado, largura: int, altura: int):
    if not resultado.face_landmarks:
        return None, None
    pts = pontos_em_pixels(resultado.face_landmarks[0], largura, altura)
    matrizes = resultado.facial_transformation_matrixes
    return pts, (matrizes[0] if matrizes else None)


class ExtratorVideo:
    """Modo vídeo do MediaPipe: síncrono, um quadro por chamada, em ordem."""

    def __init__(self, config: dict):
        self._landmarker = vision.FaceLandmarker.create_from_options(
            _opcoes(config, vision.RunningMode.VIDEO)
        )
        self._calculadora = CalculadoraMetricas(ParametrosConfianca.de_config(config))
        self.ultimos_pontos = None

    def processar(self, quadro_bgr, t_ms: int, indice: int) -> RegistroMetricas:
        inicio = time.perf_counter()
        resultado = self._landmarker.detect_for_video(_imagem(quadro_bgr), t_ms)
        altura, largura = quadro_bgr.shape[:2]
        pts, matriz = _pontos_e_matriz(resultado, largura, altura)
        self.ultimos_pontos = pts
        atraso = (time.perf_counter() - inicio) * 1000
        return self._calculadora.calcular(pts, matriz, t_ms, indice, atraso)

    def fechar(self) -> None:
        self._landmarker.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()


class ExtratorAoVivo:
    """Modo ao vivo do MediaPipe: assíncrono, com o resultado por callback.

    O MediaPipe ignora quadros enviados enquanto ainda processa o anterior, e
    esses quadros não geram registro. O atraso é medido do instante de captura
    (t_ms, no relógio da fonte) até a chegada do resultado.
    """

    def __init__(self, config: dict, ao_registrar, relogio_ms):
        self._ao_registrar = ao_registrar
        self._relogio_ms = relogio_ms
        self._calculadora = CalculadoraMetricas(ParametrosConfianca.de_config(config))
        self._indices: dict[int, int] = {}
        self._trava = threading.Lock()
        self._ultimo_t = -1
        self.ultimos_pontos = None
        self._landmarker = vision.FaceLandmarker.create_from_options(
            _opcoes(config, vision.RunningMode.LIVE_STREAM, self._ao_resultado)
        )

    def enviar(self, quadro_bgr, t_ms: int, indice: int) -> None:
        # O MediaPipe exige marcas de tempo estritamente crescentes.
        if t_ms <= self._ultimo_t:
            return
        self._ultimo_t = t_ms
        with self._trava:
            self._indices[t_ms] = indice
        self._landmarker.detect_async(_imagem(quadro_bgr), t_ms)

    def _ao_resultado(self, resultado, imagem: mp.Image, t_ms: int) -> None:
        atraso = self._relogio_ms() - t_ms
        with self._trava:
            indice = self._indices.pop(t_ms, -1)
            for t in [t for t in self._indices if t < t_ms]:
                del self._indices[t]
        pts, matriz = _pontos_e_matriz(resultado, imagem.width, imagem.height)
        self.ultimos_pontos = pts
        self._ao_registrar(self._calculadora.calcular(pts, matriz, t_ms, indice, atraso))

    def fechar(self) -> None:
        self._landmarker.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()
