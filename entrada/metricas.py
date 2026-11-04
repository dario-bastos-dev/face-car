"""Métricas faciais por quadro (Parte 1), no contrato metricas.v1 das Partes 2 e 3.

Confiança do rastreio, cálculo do registro de um quadro e os adaptadores do MediaPipe
nos modos vídeo e ao vivo. O MediaPipe só é importado quando um extrator é criado,
porque a importação leva alguns segundos.
"""

import math
import threading
import time
from dataclasses import dataclass

import cv2

from entrada import geometria
from entrada.contexto import carregar_pontos_rosto
from entrada.contrato import RAIZ, RegistroMetricas
from entrada.geometria import residuo_alinhado
from entrada.rosto import indice_do_maior_rosto, pontos_em_pixels


# ---- confiança do rastreio -------------------------------------------------

@dataclass
class ParametrosConfianca:
    escala_residuo: float = 0.02
    alfa_suavizacao: float = 0.3
    valor_inicial: float = 0.5
    intervalo_max_ms: int = 500

    @classmethod
    def de_config(cls, config: dict) -> "ParametrosConfianca":
        return cls(**config["confianca"])


class Estabilidade:
    """Acompanha os pontos rígidos quadro a quadro e devolve a confiança.

    - Sem rosto: confiança 0 e o histórico é zerado.
    - Primeiro quadro com rosto, ou depois de um intervalo maior que
      intervalo_max_ms: confiança igual a valor_inicial.
    - Nos demais: o resíduo do alinhamento com o quadro anterior, dividido pela
      distância de referência (entre os cantos externos dos olhos), é suavizado
      por média exponencial, e a confiança é exp(-resíduo / escala_residuo).
    """

    def __init__(self, parametros: ParametrosConfianca):
        self.p = parametros
        self._anterior = None
        self._t_anterior = None
        self._residuo = None

    def atualizar(self, pontos_rigidos, t_ms: int, distancia_ref: float) -> float:
        if pontos_rigidos is None or distancia_ref <= 0:
            self._anterior = self._t_anterior = self._residuo = None
            return 0.0

        continua = (
            self._anterior is not None
            and t_ms - self._t_anterior <= self.p.intervalo_max_ms
        )
        if continua:
            r = residuo_alinhado(self._anterior, pontos_rigidos) / distancia_ref
            if self._residuo is None:
                self._residuo = r
            else:
                a = self.p.alfa_suavizacao
                self._residuo = a * r + (1 - a) * self._residuo
            confianca = math.exp(-self._residuo / self.p.escala_residuo)
        else:
            self._residuo = None
            confianca = self.p.valor_inicial

        self._anterior = pontos_rigidos
        self._t_anterior = t_ms
        return confianca


# ---- registro de um quadro -------------------------------------------------

class CalculadoraMetricas:
    """Núcleo do extrator, sem entrada nem saída.

    Recebe os pontos em pixels e a matriz de transformação facial (ou None
    quando não há rosto) e devolve o registro do quadro. Guarda estado apenas
    para a estabilidade, então os quadros precisam chegar em ordem.
    """

    def __init__(self, parametros: ParametrosConfianca, pontos: dict | None = None):
        self.pontos = pontos or carregar_pontos_rosto()
        self.estabilidade = Estabilidade(parametros)

    def calcular(self, pts, matriz, t_ms: int, quadro: int, atraso_ms=None) -> RegistroMetricas:
        if pts is None:
            confianca = self.estabilidade.atualizar(None, t_ms, 0.0)
            return RegistroMetricas(t_ms, quadro, False, confianca=confianca, atraso_ms=atraso_ms)

        ip = self.pontos
        ref_a, ref_b = ip["referencia_escala"]
        confianca = self.estabilidade.atualizar(
            pts[ip["rigidos"]], t_ms, geometria.distancia(pts[ref_a], pts[ref_b])
        )
        canto_a, canto_b = ip["boca_cantos"]
        yaw = pitch = roll = None
        if matriz is not None:
            yaw, pitch, roll = geometria.angulos_da_matriz(matriz)

        return RegistroMetricas(
            t_ms=t_ms,
            quadro=quadro,
            rosto_visivel=True,
            ear_esq=geometria.ear(pts[ip["olho_esquerdo"]]),
            ear_dir=geometria.ear(pts[ip["olho_direito"]]),
            abertura_boca=geometria.abertura_boca(
                [(pts[a], pts[b]) for a, b in ip["boca_pares_verticais"]],
                pts[canto_a],
                pts[canto_b],
            ),
            yaw=yaw,
            pitch=pitch,
            roll=roll,
            confianca=confianca,
            atraso_ms=atraso_ms,
        )


# ---- extratores (MediaPipe nos modos vídeo e ao vivo) ----------------------

def _criar_landmarker(config: dict, modo: str, callback=None):
    """Face Landmarker no modo "VIDEO" ou "LIVE_STREAM"; importa o MediaPipe só aqui."""
    from mediapipe.tasks.python import BaseOptions, vision

    mpc = config["mediapipe"]
    opcoes = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(RAIZ / mpc["modelo"])),
        running_mode=getattr(vision.RunningMode, modo),
        num_faces=mpc["max_rostos"],
        min_face_detection_confidence=mpc["min_confianca_deteccao"],
        min_face_presence_confidence=mpc["min_confianca_presenca"],
        min_tracking_confidence=mpc["min_confianca_rastreio"],
        output_facial_transformation_matrixes=True,
        result_callback=callback,
    )
    return vision.FaceLandmarker.create_from_options(opcoes)


def _imagem(quadro_bgr):
    import mediapipe as mp

    rgb = cv2.cvtColor(quadro_bgr, cv2.COLOR_BGR2RGB)
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)


def _pontos_e_matriz(resultado, largura: int, altura: int):
    """Pontos em pixels e matriz de pose do maior rosto, o do motorista, ou (None, None).

    O MediaPipe devolve primeiro o rosto em que mais confia, que pode ser alguém ao
    fundo; a escolha é a mesma da análise (entrada.rosto.DetectorRosto).
    """
    rostos = [pontos_em_pixels(r, largura, altura) for r in resultado.face_landmarks]
    i = indice_do_maior_rosto(rostos)
    if i is None:
        return None, None
    matrizes = resultado.facial_transformation_matrixes
    return rostos[i], (matrizes[i] if matrizes else None)


class ExtratorVideo:
    """Modo vídeo do MediaPipe: síncrono, um quadro por chamada, em ordem."""

    def __init__(self, config: dict):
        self._landmarker = _criar_landmarker(config, "VIDEO")
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
        self._landmarker = _criar_landmarker(config, "LIVE_STREAM", self._ao_resultado)

    def enviar(self, quadro_bgr, t_ms: int, indice: int) -> None:
        # O MediaPipe exige marcas de tempo estritamente crescentes.
        if t_ms <= self._ultimo_t:
            return
        self._ultimo_t = t_ms
        with self._trava:
            self._indices[t_ms] = indice
        self._landmarker.detect_async(_imagem(quadro_bgr), t_ms)

    def _ao_resultado(self, resultado, imagem, t_ms: int) -> None:
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
