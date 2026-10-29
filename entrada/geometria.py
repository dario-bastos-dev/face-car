"""Cálculos geométricos sobre os pontos do rosto, sem dependência do MediaPipe.

A versão em JavaScript (demo-navegador/extrator.js) repete estas fórmulas e
passa pelos mesmos casos de teste em testes/casos/geometria.json.
"""

import math

import numpy as np


def distancia(a, b) -> float:
    return float(math.hypot(a[0] - b[0], a[1] - b[1]))


def ear(p) -> float:
    """Eye Aspect Ratio de seis pontos na ordem p1..p6.

    p1 e p4 são os cantos do olho; p2/p6 e p3/p5 são os pares vertical
    superior/inferior. EAR = (|p2-p6| + |p3-p5|) / (2 |p1-p4|).
    """
    largura = distancia(p[0], p[3])
    if largura == 0:
        return 0.0
    return (distancia(p[1], p[5]) + distancia(p[2], p[4])) / (2.0 * largura)


def abertura_boca(pares_verticais, canto_a, canto_b) -> float:
    """Média das distâncias verticais internas dividida pela largura interna."""
    largura = distancia(canto_a, canto_b)
    if largura == 0:
        return 0.0
    vertical = sum(distancia(a, b) for a, b in pares_verticais) / len(pares_verticais)
    return vertical / largura


def angulos_da_matriz(matriz) -> tuple[float, float, float]:
    """(yaw, pitch, roll) em graus a partir da matriz 4x4 de transformação facial.

    Decomposição ZYX: R = Rz(roll) · Ry(yaw) · Rx(pitch), no sistema de câmera
    do MediaPipe (x para a direita, y para cima, z na direção da câmera). As
    colunas são normalizadas para remover uma eventual escala.
    """
    r = np.asarray(matriz, dtype=float)[:3, :3]
    r = r / np.linalg.norm(r, axis=0)
    pitch = math.atan2(r[2, 1], r[2, 2])
    yaw = math.atan2(-r[2, 0], math.hypot(r[2, 1], r[2, 2]))
    roll = math.atan2(r[1, 0], r[0, 0])
    return math.degrees(yaw), math.degrees(pitch), math.degrees(roll)


def residuo_alinhado(anterior, atual) -> float:
    """RMS do que sobra entre dois conjuntos de pontos 2D após alinhá-los.

    O alinhamento por semelhança (translação, rotação e escala) remove o
    movimento rígido da cabeça; o resíduo mede o tremor dos pontos. Usa números
    complexos: o fator ótimo é s = Σ conj(a)·b / Σ |a|².
    """
    a = np.asarray(anterior, dtype=float)
    b = np.asarray(atual, dtype=float)
    za = (a[:, 0] - a[:, 0].mean()) + 1j * (a[:, 1] - a[:, 1].mean())
    zb = (b[:, 0] - b[:, 0].mean()) + 1j * (b[:, 1] - b[:, 1].mean())
    energia = float(np.sum(np.abs(za) ** 2))
    if energia == 0:
        return 0.0
    s = np.sum(np.conj(za) * zb) / energia
    resto = zb - s * za
    return float(np.sqrt(np.mean(np.abs(resto) ** 2)))
