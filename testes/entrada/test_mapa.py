import math

import numpy as np
import pytest

from entrada.contexto import carregar_pontos_rosto
from entrada.mapa import (angulos_da_direcao, descrever, desenhar_mapa, direcao_da_cabeca,
                          olhar_da_iris)

INDICES = carregar_pontos_rosto()


def matriz(rotacao):
    m = np.eye(4)
    m[:3, :3] = rotacao
    m[:3, 3] = [1.0, -2.0, -40.0]
    return m


def gira_y(graus):  # rosto virado para a direita da imagem com graus > 0
    a = math.radians(graus)
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


def gira_x(graus):  # cabeça para baixo com graus > 0
    a = math.radians(graus)
    return np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])


def test_cabeca_de_frente():
    d = direcao_da_cabeca(matriz(np.eye(3)))
    assert d == pytest.approx([0, 0, 1])
    assert angulos_da_direcao(d) == pytest.approx((0, 0))


def test_cabeca_virada_e_inclinada():
    assert angulos_da_direcao(direcao_da_cabeca(matriz(gira_y(30)))) == pytest.approx((30, 0))
    horizontal, vertical = angulos_da_direcao(direcao_da_cabeca(matriz(gira_x(20))))
    assert horizontal == pytest.approx(0) and vertical == pytest.approx(-20)


def test_direcao_ignora_escala_da_matriz():
    assert direcao_da_cabeca(matriz(1.7 * gira_y(30))) == pytest.approx(
        direcao_da_cabeca(matriz(gira_y(30))))


@pytest.mark.parametrize("horizontal, vertical, esperado", [
    (0, 0, "frente"),
    (30, 0, "esquerda"),     # rosto para a direita da imagem = esquerda do motorista
    (-30, 0, "direita"),
    (0, -20, "baixo"),
    (0, 20, "cima"),
    (25, -20, "baixo e esquerda"),
    (10, -10, "frente"),     # abaixo do limiar
])
def test_descrever(horizontal, vertical, esperado):
    assert descrever(horizontal, vertical, limiar=15) == esperado


def test_olhar_da_iris():
    pts = np.zeros((478, 2))
    # Olho direito do motorista: cantos 33 e 133, centro em x=120; íris (468) em x=130.
    pts[33], pts[133], pts[468] = (100, 100), (140, 100), (130, 100)
    # Olho esquerdo: cantos 362 e 263, centro em x=180; íris (473) em x=190.
    pts[362], pts[263], pts[473] = (160, 100), (200, 100), (190, 106)
    dx, dy = olhar_da_iris(pts, INDICES)
    assert dx == pytest.approx(0.5)     # meio caminho até o canto, nos dois olhos
    assert dy == pytest.approx(0.15)    # média de 0 e 6/20


def rosto_sintetico(cx=200, cy=210, raio=80):
    angulos = np.linspace(0, 2 * np.pi, 478, endpoint=False)
    return np.c_[cx + raio * np.cos(angulos), cy + raio * np.sin(angulos)]


def test_desenhar_mapa_desenha_contornos_e_descreve():
    pts = rosto_sintetico()
    quadro = np.zeros((320, 400, 3), np.uint8)
    linhas = desenhar_mapa(quadro, pts, matriz(gira_x(30)), INDICES)
    assert linhas[0] == "cabeca: baixo"
    assert linhas[1].startswith("olhar: ")
    for nome in ("contorno_rosto", "contorno_olho_esquerdo", "contorno_labios_externo"):
        for i in INDICES[nome]:
            x, y = np.round(pts[i]).astype(int)
            assert quadro[y - 1:y + 2, x - 1:x + 2].any(), f"{nome}: ponto {i}"


def test_desenhar_mapa_sem_matriz_nao_descreve_a_cabeca():
    linhas = desenhar_mapa(np.zeros((320, 400, 3), np.uint8), rosto_sintetico(), None, INDICES)
    assert not any(l.startswith("cabeca") for l in linhas)
