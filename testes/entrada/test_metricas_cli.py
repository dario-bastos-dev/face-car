"""Linha de comando das métricas: CSV do contrato, comparação e desenho na janela."""

import numpy as np
import pytest

from entrada.__main__ import main
from entrada.contexto import RAIZ, carregar_pontos_rosto
from entrada.contrato import EscritorMetricas, RegistroMetricas, ler_metricas
from entrada.metricas_cli import comparar, desenhar


# ---- test_metricas_cli -----------------------------------------------------

VIDEO = RAIZ / "testes" / "dados" / "retrato.mp4"
MODELO = RAIZ / "modelos" / "face_landmarker.task"


@pytest.mark.skipif(not (VIDEO.exists() and MODELO.exists()), reason="rode scripts/preparar.sh")
def test_metricas_video_grava_o_csv_do_contrato(tmp_path):
    saida = tmp_path / "metricas.csv"
    assert main(["metricas", "video", str(VIDEO), "-o", str(saida)]) == 0
    registros = ler_metricas(saida)  # o mesmo leitor que o estimador da Parte 2 usa
    assert len(registros) == 120
    assert registros[30].rosto_visivel is False and registros[0].ear_esq is not None


def test_metricas_video_inexistente_da_mensagem_clara(tmp_path, capsys):
    assert main(["metricas", "video", str(tmp_path / "nao.mp4")]) == 2
    assert "não encontrado" in capsys.readouterr().err


# ---- test_comparar ---------------------------------------------------------

def gravar(caminho, registros):
    with EscritorMetricas(caminho) as escritor:
        for r in registros:
            escritor.escrever(r)
    return caminho


def sequencia(n, passo_ms=40, ear=0.3):
    return [RegistroMetricas(i * passo_ms, i, True, ear, ear, 0.1, 1.0, 2.0, 3.0, 0.9, 5.0)
            for i in range(n)]


def test_arquivos_alinhados_nao_geram_alerta(tmp_path):
    a = gravar(tmp_path / "a.csv", sequencia(5))
    b = gravar(tmp_path / "b.csv", sequencia(5, ear=0.31))
    r = comparar(a, b)
    assert r["alertas"] == []
    assert r["diferencas"]["ear_esq"]["max"] == pytest_approx(0.01)
    assert main(["comparar", str(a), str(b)]) == 0


def test_numero_de_quadros_diferente_gera_alerta(tmp_path):
    a = gravar(tmp_path / "a.csv", sequencia(5))
    b = gravar(tmp_path / "b.csv", sequencia(7))
    r = comparar(a, b)
    assert any("quadros" in alerta for alerta in r["alertas"])
    assert main(["comparar", str(a), str(b)]) == 1


def test_marca_de_tempo_divergente_gera_alerta(tmp_path):
    # Mesmo número de quadros, mas fps diferente: os índices não são os mesmos instantes.
    a = gravar(tmp_path / "a.csv", sequencia(5, passo_ms=40))
    b = gravar(tmp_path / "b.csv", sequencia(5, passo_ms=33))
    r = comparar(a, b)
    assert any("t_ms" in alerta for alerta in r["alertas"])
    assert main(["comparar", str(a), str(b)]) == 1


def pytest_approx(valor):
    import pytest
    return pytest.approx(valor, abs=1e-4)


# ---- test_sobreposicao -----------------------------------------------------

INDICES = carregar_pontos_rosto()
ALTURA, LARGURA = 320, 400
TOPO_LIVRE = 120  # abaixo do painel de texto


def rosto_sintetico(cx=200, cy=210, raio=80):
    """478 pontos num círculo, abaixo do painel de texto."""
    angulos = np.linspace(0, 2 * np.pi, 478, endpoint=False)
    return np.c_[cx + raio * np.cos(angulos), cy + raio * np.sin(angulos)]


def registro(**pose):
    base = dict(yaw=0.0, pitch=0.0, roll=0.0)
    base.update(pose)
    return RegistroMetricas(0, 0, True, 0.3, 0.3, 0.05, confianca=0.9, atraso_ms=10.0, **base)


def quadro_vazio():
    return np.zeros((ALTURA, LARGURA, 3), np.uint8)


def test_desenha_o_contorno_do_rosto():
    pts = rosto_sintetico()
    quadro = quadro_vazio()
    desenhar(quadro, registro(), pts, INDICES)
    for i in INDICES["contorno_rosto"]:
        x, y = np.round(pts[i]).astype(int)
        if y > TOPO_LIVRE:
            assert quadro[y - 1:y + 2, x - 1:x + 2].any(), f"ponto {i} do contorno"


def test_seta_aponta_para_baixo_com_a_cabeca_baixa():
    pts = rosto_sintetico()
    nariz_y = pts[INDICES["ponta_nariz"]][1]
    baixa, frente = quadro_vazio(), quadro_vazio()
    desenhar(baixa, registro(pitch=40.0), pts, INDICES)
    desenhar(frente, registro(pitch=0.0), pts, INDICES)
    # Abaixo do painel, só a seta muda entre os dois quadros.
    ys, _ = np.nonzero((baixa[TOPO_LIVRE:] != frente[TOPO_LIVRE:]).any(axis=2))
    assert ys.size and (ys + TOPO_LIVRE).mean() > nariz_y


def test_nao_quebra_sem_pose_nem_rosto():
    quadro = quadro_vazio()
    desenhar(quadro, registro(yaw=None, pitch=None, roll=None), rosto_sintetico(), INDICES)
    sem_rosto = RegistroMetricas(0, 0, False, confianca=0.0, atraso_ms=5.0)
    desenhar(quadro, sem_rosto, None, INDICES)


CONTORNOS = ["contorno_olho_esquerdo", "contorno_olho_direito",
             "contorno_labios_externo", "contorno_labios_interno"]


def test_indices_dos_contornos_sao_coerentes():
    for nome in CONTORNOS + ["iris_esquerda", "iris_direita"]:
        assert all(0 <= i < 478 for i in INDICES[nome]), nome
        assert len(set(INDICES[nome])) == len(INDICES[nome]), nome
    assert len(INDICES["contorno_olho_esquerdo"]) == len(INDICES["contorno_olho_direito"]) == 16
    assert len(INDICES["contorno_labios_externo"]) == len(INDICES["contorno_labios_interno"]) == 20
    # Os pontos do cálculo fazem parte dos contornos desenhados.
    assert set(INDICES["olho_esquerdo"]) <= set(INDICES["contorno_olho_esquerdo"])
    assert set(INDICES["olho_direito"]) <= set(INDICES["contorno_olho_direito"])
    boca = {i for par in INDICES["boca_pares_verticais"] for i in par} | set(INDICES["boca_cantos"])
    assert boca <= set(INDICES["contorno_labios_interno"])


def test_desenha_todos_os_pontos_dos_olhos_e_da_boca():
    pts = rosto_sintetico()
    quadro = quadro_vazio()
    desenhar(quadro, registro(), pts, INDICES)
    for nome in CONTORNOS:
        for i in INDICES[nome]:
            x, y = np.round(pts[i]).astype(int)
            if y > TOPO_LIVRE:
                assert quadro[y - 1:y + 2, x - 1:x + 2].any(), f"{nome}: ponto {i}"
