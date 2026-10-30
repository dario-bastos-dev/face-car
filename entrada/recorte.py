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


def maior_rosto(rostos):
    """O rosto de maior área: o de quem está mais perto da câmera, o motorista."""
    def area(pts):
        (x0, y0), (x1, y1) = pts.min(axis=0), pts.max(axis=0)
        return (x1 - x0) * (y1 - y0)

    return max(rostos, key=area, default=None)


# Olhos e boca: mesmo recorte de treinamento/preparar_regioes.py, com o qual as CNNs
# de olhos e boca foram treinadas. Mudar estes valores aqui sem mudar lá faz o modelo
# receber imagens diferentes das do treino.
MARGEM_X = 0.35
MARGEM_Y = 0.45
MARGEM_MINIMA_PX = 8


def caixa_da_regiao(pontos, indices, largura: int, altura: int):
    """(x0, y0, x1, y1) da região, cortada nas bordas da imagem, sem preenchimento."""
    xs = [pontos[i][0] for i in indices]
    ys = [pontos[i][1] for i in indices]
    margem_x = max(MARGEM_MINIMA_PX, (max(xs) - min(xs)) * MARGEM_X)
    margem_y = max(MARGEM_MINIMA_PX, (max(ys) - min(ys)) * MARGEM_Y)
    x0, x1 = max(0, int(min(xs) - margem_x)), min(largura, int(max(xs) + margem_x))
    y0, y1 = max(0, int(min(ys) - margem_y)), min(altura, int(max(ys) + margem_y))
    return x0, y0, x1, y1


def recortar_regiao(quadro, pontos, indices, tamanho: int):
    """Recorte da região redimensionado para tamanho x tamanho, ou None se vazio."""
    altura, largura = quadro.shape[:2]
    x0, y0, x1, y1 = caixa_da_regiao(pontos, indices, largura, altura)
    if x1 <= x0 or y1 <= y0:
        return None
    return cv2.resize(quadro[y0:y1, x0:x1], (tamanho, tamanho), interpolation=cv2.INTER_AREA)


def indices_das_regioes(pontos_rosto: dict) -> dict:
    """Índices de olhos e boca, escolhidos como em treinamento/preparar_regioes.py."""
    return {
        "olhos": sorted(set(pontos_rosto["olho_esquerdo"] + pontos_rosto["olho_direito"])),
        "boca": sorted(set(sum(pontos_rosto["boca_pares_verticais"], [])
                           + list(pontos_rosto["boca_cantos"]))),
    }
