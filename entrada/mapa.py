"""Mapeamento do rosto para a janela de visualização: contornos, íris e direções.

Só desenha sobre a imagem mostrada na tela; a imagem enviada ao modelo não recebe
estas marcas. Direções são descritas do ponto de vista do motorista:
a câmera não espelha a imagem, então quando ele olha para a esquerda dele, o
rosto e as íris vão para a direita da imagem.
"""

import math

import cv2
import numpy as np

LIMIAR_CABECA_GRAUS = 15
LIMIAR_OLHAR = 0.2  # deslocamento da íris, em metades da largura do olho

COR_ROSTO = (255, 200, 0)
COR_OLHOS_BOCA = (90, 200, 90)
COR_IRIS = (255, 120, 255)
COR_CABECA = (0, 220, 255)


def direcao_da_cabeca(matriz) -> np.ndarray:
    """Vetor unitário para onde o rosto aponta, a partir da matriz 4x4 do MediaPipe.

    É o eixo z do modelo do rosto (terceira coluna da rotação), no sistema de
    câmera do MediaPipe: x para a direita da imagem, y para cima, z para a câmera.
    """
    rotacao = np.asarray(matriz, dtype=float)[:3, :3]
    frente = rotacao[:, 2]
    return frente / np.linalg.norm(frente)


def angulos_da_direcao(direcao) -> tuple[float, float]:
    """(horizontal, vertical) em graus: positivos para a direita da imagem e para cima."""
    x, y, z = direcao
    return math.degrees(math.atan2(x, z)), math.degrees(math.atan2(y, z))


def descrever(horizontal: float, vertical: float, limiar: float) -> str:
    """Rótulo como "frente", "baixo" ou "baixo e esquerda", do ponto de vista do motorista."""
    partes = []
    if vertical > limiar:
        partes.append("cima")
    elif vertical < -limiar:
        partes.append("baixo")
    if horizontal > limiar:
        partes.append("esquerda")  # direita da imagem
    elif horizontal < -limiar:
        partes.append("direita")
    return " e ".join(partes) or "frente"


def rotulo_da_cabeca(matriz) -> str:
    """Para onde a cabeça aponta, como "frente" ou "baixo e esquerda"."""
    return descrever(*angulos_da_direcao(direcao_da_cabeca(matriz)), LIMIAR_CABECA_GRAUS)


def _olhos(pontos, indices):
    """Para cada olho: centro, eixo unitário (cantos, para a direita da imagem),
    meia largura e os 5 pontos da íris (o primeiro é o centro)."""
    for olho, iris in (("olho_direito", "iris_direita"), ("olho_esquerdo", "iris_esquerda")):
        a, b = pontos[indices[olho][0]], pontos[indices[olho][3]]
        largura = float(np.linalg.norm(b - a))
        yield (a + b) / 2, (b - a) / largura, largura / 2, pontos[indices[iris]]


def olhar_da_iris(pontos, indices) -> tuple[float, float]:
    """Deslocamento médio das íris em relação ao centro dos olhos.

    Medido ao longo do eixo de cada olho (dx, positivo para a direita da imagem)
    e na perpendicular (dy, positivo para baixo), em metades da largura do olho,
    para que inclinar a cabeça não seja lido como olhar para cima ou para baixo.
    """
    desvios = []
    for centro, eixo, meia, iris in _olhos(pontos, indices):
        normal = np.array([-eixo[1], eixo[0]])
        desvio = iris[0] - centro
        desvios.append((desvio @ eixo / meia, desvio @ normal / meia))
    dx, dy = np.mean(desvios, axis=0)
    return float(dx), float(dy)


def _ponto(p):
    return tuple(int(v) for v in np.round(p))


def desenhar_mapa(quadro, pontos, matriz, indices) -> list[str]:
    """Desenha contornos, íris e setas de direção; devolve as linhas de texto.

    Sem matriz de pose, a seta e o rótulo da cabeça são omitidos.
    """
    def contorno(nome, cor):
        pts = np.round(pontos[indices[nome]]).astype(np.int32)
        cv2.polylines(quadro, [pts], True, cor, 1, cv2.LINE_AA)
        return pts

    contorno("contorno_rosto", COR_ROSTO)
    for nome in ("contorno_olho_esquerdo", "contorno_olho_direito",
                 "contorno_labios_externo", "contorno_labios_interno"):
        for x, y in contorno(nome, COR_OLHOS_BOCA):
            cv2.circle(quadro, (int(x), int(y)), 1, COR_OLHOS_BOCA, -1)

    # Íris e olhar: setas saindo de cada íris, ampliadas para ficarem visíveis.
    dx, dy = olhar_da_iris(pontos, indices)
    for _, eixo, meia, iris in _olhos(pontos, indices):
        centro_iris, borda = iris[0], iris[1:]
        raio = max(1, round(float(np.mean(np.linalg.norm(borda - centro_iris, axis=1)))))
        cv2.circle(quadro, _ponto(centro_iris), raio, COR_IRIS, 1, cv2.LINE_AA)
        normal = np.array([-eixo[1], eixo[0]])
        seta = (dx * eixo + dy * normal) * meia * 3
        if np.hypot(*seta) >= 2:
            cv2.arrowedLine(quadro, _ponto(centro_iris), _ponto(centro_iris + seta), COR_IRIS, 1,
                            cv2.LINE_AA, tipLength=0.3)

    linhas = []
    if matriz is not None:
        direcao = direcao_da_cabeca(matriz)
        a, b = indices["referencia_escala"]
        comprimento = 1.5 * float(np.linalg.norm(pontos[a] - pontos[b]))
        seta = np.array([direcao[0], -direcao[1]]) * comprimento  # imagem com y para baixo
        if np.hypot(*seta) >= 2:
            nariz = pontos[indices["ponta_nariz"]]
            cv2.arrowedLine(quadro, _ponto(nariz), _ponto(nariz + seta), COR_CABECA, 2,
                            cv2.LINE_AA, tipLength=0.25)
        linhas.append("cabeca: " + rotulo_da_cabeca(matriz))
    linhas.append("olhar: " + descrever(dx, -dy, LIMIAR_OLHAR))
    return linhas
