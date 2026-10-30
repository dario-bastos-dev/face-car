import numpy as np
import pytest

from entrada.recorte import (Caixa, caixa_da_regiao, caixa_do_rosto, maior_rosto, recortar,
                             recortar_regiao)


def quadrado(x0, y0, lado, n=50):
    """Pontos espalhados num quadrado, como uma malha de rosto simplificada."""
    rng = np.random.default_rng(0)
    pts = rng.uniform(0, lado, (n, 2)) + [x0, y0]
    pts[:4] = [[x0, y0], [x0 + lado, y0], [x0, y0 + lado], [x0 + lado, y0 + lado]]
    return pts


def test_caixa_e_quadrada_centrada_e_com_margem():
    pts = np.array([[100, 50], [140, 50], [100, 130], [140, 130]], float)  # 40 x 80
    c = caixa_do_rosto(pts, margem=0.25)
    assert (c.cx, c.cy) == (120, 90)
    assert c.lado == pytest.approx(80 * 1.5)


def test_recorte_tem_o_tamanho_pedido():
    quadro = np.zeros((480, 640, 3), np.uint8)
    assert recortar(quadro, Caixa(320, 240, 150), 224).shape == (224, 224, 3)


def test_recorte_pega_a_regiao_da_caixa():
    quadro = np.zeros((200, 200, 3), np.uint8)
    quadro[50:150, 50:150] = 255
    rec = recortar(quadro, Caixa(100, 100, 100), 50)
    assert rec.min() == 255


def test_rosto_na_borda_fica_centrado_com_preenchimento():
    quadro = np.full((200, 200, 3), 255, np.uint8)
    # Caixa centrada no canto: três quartos dela ficam fora da imagem.
    rec = recortar(quadro, Caixa(0, 0, 100), 100)
    assert rec.shape == (100, 100, 3)
    assert rec[75, 75].min() == 255      # parte dentro da imagem
    assert rec[10, 10].max() == 0        # parte fora, preenchida de preto


def test_maior_rosto():
    pequeno, grande = quadrado(0, 0, 30), quadrado(100, 100, 90)
    assert maior_rosto([pequeno, grande]) is grande
    assert maior_rosto([]) is None


# Recorte de olhos e boca: tem de ser idêntico ao de treinamento/preparar_regioes.py,
# com o qual as CNNs foram treinadas (margem de 35% na horizontal e 45% na vertical,
# no mínimo 8 px, cortada nas bordas da imagem, sem preenchimento).

def test_caixa_da_regiao_segue_o_recorte_do_treino():
    pts = np.zeros((20, 2))
    pts[[3, 4, 5, 6]] = [[100, 100], [140, 100], [100, 110], [140, 110]]  # 40 x 10 px
    # margem x = max(8, 14) = 14; margem y = max(8, 4,5) = 8
    assert caixa_da_regiao(pts, [3, 4, 5, 6], 640, 480) == (86, 92, 154, 118)


def test_caixa_da_regiao_e_cortada_na_borda():
    pts = np.array([[2.0, 3.0], [30.0, 20.0]])
    x0, y0, x1, y1 = caixa_da_regiao(pts, [0, 1], 32, 24)
    assert (x0, y0) == (0, 0) and (x1, y1) == (32, 24)


def test_recortar_regiao_redimensiona_para_o_tamanho():
    quadro = np.zeros((480, 640, 3), np.uint8)
    quadro[92:118, 86:154] = 200
    pts = np.array([[100, 100], [140, 100], [100, 110], [140, 110]], float)
    rec = recortar_regiao(quadro, pts, [0, 1, 2, 3], 96)
    assert rec.shape == (96, 96, 3) and rec.min() == 200


def test_recortar_regiao_fora_da_imagem_devolve_none():
    quadro = np.zeros((100, 100, 3), np.uint8)
    pts = np.array([[500.0, 500.0], [520.0, 510.0]])
    assert recortar_regiao(quadro, pts, [0, 1], 96) is None
