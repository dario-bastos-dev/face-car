"""Recorte quadrado do rosto a partir dos pontos do MediaPipe, sem dependência dele."""

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class Caixa:
    """Quadrado em pixels: centro (cx, cy) e lado."""

    cx: float
    cy: float
    lado: float


def caixa_do_rosto(pontos, margem: float) -> Caixa:
    """Quadrado centrado nos pontos do rosto, com o lado do maior eixo ampliado.

    A margem é uma fração de cada lado: 0,25 deixa o quadrado 1,5 vez maior
    que o rosto, o bastante para incluir o queixo, a testa e a inclinação da
    cabeça.
    """
    pts = np.asarray(pontos, dtype=float)
    (x0, y0), (x1, y1) = pts.min(axis=0), pts.max(axis=0)
    lado = max(x1 - x0, y1 - y0) * (1 + 2 * margem)
    return Caixa((x0 + x1) / 2, (y0 + y1) / 2, lado)


def recortar(quadro, caixa: Caixa, tamanho: int):
    """Recorta a caixa e a redimensiona para tamanho x tamanho.

    A parte da caixa que cai fora da imagem é preenchida de preto, para que o
    rosto continue centrado mesmo perto da borda.
    """
    lado = max(1, round(caixa.lado))
    x0 = round(caixa.cx - lado / 2)
    y0 = round(caixa.cy - lado / 2)
    altura, largura = quadro.shape[:2]
    borda = max(0, -x0, -y0, x0 + lado - largura, y0 + lado - altura)
    if borda:
        quadro = cv2.copyMakeBorder(quadro, borda, borda, borda, borda,
                                    cv2.BORDER_CONSTANT, value=(0, 0, 0))
        x0 += borda
        y0 += borda
    regiao = quadro[y0:y0 + lado, x0:x0 + lado]
    interpolacao = cv2.INTER_AREA if lado > tamanho else cv2.INTER_LINEAR
    return cv2.resize(regiao, (tamanho, tamanho), interpolation=interpolacao)


def indice_do_maior_rosto(rostos):
    """Índice do rosto de maior área, o de quem está mais perto da câmera, ou None."""
    def area(i):
        (x0, y0), (x1, y1) = rostos[i].min(axis=0), rostos[i].max(axis=0)
        return (x1 - x0) * (y1 - y0)

    return max(range(len(rostos)), key=area, default=None)


def maior_rosto(rostos):
    """O rosto de maior área: o do motorista."""
    i = indice_do_maior_rosto(rostos)
    return None if i is None else rostos[i]

