import numpy as np
import pytest

from entrada.recorte import Caixa, caixa_do_rosto, maior_rosto, recortar


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

