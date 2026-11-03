"""Transforma os pontos de um quadro em um registro do contrato de métricas."""

import json
from pathlib import Path

import numpy as np

from entrada import geometria
from entrada.confianca import Estabilidade, ParametrosConfianca
from entrada.contrato import RegistroMetricas

CAMINHO_PONTOS = Path(__file__).resolve().parent / "pontos_rosto.json"


def carregar_pontos(caminho: Path = CAMINHO_PONTOS) -> dict:
    return json.loads(Path(caminho).read_text(encoding="utf-8"))


def pontos_em_pixels(landmarks, largura: int, altura: int) -> np.ndarray:
    """Converte pontos normalizados do MediaPipe em pixels (N, 2).

    As distâncias precisam estar em pixels: em coordenadas normalizadas, uma
    imagem não quadrada distorce o EAR.
    """
    return np.array([(p.x * largura, p.y * altura) for p in landmarks], dtype=float)


class CalculadoraMetricas:
    """Núcleo do extrator, sem entrada nem saída.

    Recebe os pontos em pixels e a matriz de transformação facial (ou None
    quando não há rosto) e devolve o registro do quadro. Guarda estado apenas
    para a estabilidade, então os quadros precisam chegar em ordem.
    """

    def __init__(self, parametros: ParametrosConfianca, pontos: dict | None = None):
        self.pontos = pontos or carregar_pontos()
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
