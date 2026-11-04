"""Rosto: detecção (MediaPipe), direção da cabeça e do olhar, olhos, boca e eventos."""

import json
import math

import cv2
import numpy as np
import pytest

from entrada import geometria
from entrada.contexto import RAIZ, carregar_pontos_rosto
from entrada.rosto import (LimiaresRosto, MonitorRosto, angulos_da_direcao, descrever,
                           desenhar_mapa, direcao_da_cabeca, formatar_estado, medidas,
                           olhar_da_iris)


# ---- test_detector ---------------------------------------------------------

DADOS = RAIZ / "testes" / "dados"
MODELO = RAIZ / "modelos" / "face_landmarker.task"

precisa_mediapipe = pytest.mark.skipif(
    not ((DADOS / "retrato.mp4").exists() and MODELO.exists()),
    reason="rode scripts/preparar.sh para baixar o modelo e gerar o vídeo",
)


@pytest.fixture
def detector():
    from entrada.rosto import DetectorRosto

    config = json.loads((RAIZ / "config" / "analise.json").read_text())
    with DetectorRosto(config) as d:
        yield d


@precisa_mediapipe
def test_rosto_presente_e_ausente(detector):
    from entrada.fontes import FonteArquivo

    with FonteArquivo(DADOS / "retrato.mp4") as fonte:
        achados = {i: detector.detectar(q, t) is not None for q, t, i in fonte}
    assert all(achados[i] for i in range(30))
    assert not any(achados[i] for i in range(30, 46))  # tela preta


@precisa_mediapipe
def test_escolhe_o_maior_rosto(detector):
    retrato = cv2.imread(str(DADOS / "retrato.jpg"))
    grande = cv2.resize(retrato, (410, 512))
    pequeno = cv2.resize(retrato, (205, 256))
    cena = np.full((512, 700, 3), 128, np.uint8)
    cena[:, :410] = grande
    cena[128:384, 470:675] = pequeno
    rosto = detector.detectar(cena, 0)
    assert rosto is not None
    assert rosto.pontos[:, 0].max() < 410  # o rosto escolhido está no retrato grande
    # A matriz de pose é a do mesmo rosto: de frente, aponta para a câmera (z > 0.9).
    assert rosto.matriz.shape == (4, 4)
    frente = rosto.matriz[:3, 2] / np.linalg.norm(rosto.matriz[:3, 2])
    assert frente[2] > 0.9


def quadrado(x0, y0, lado):
    return np.array([[x0, y0], [x0 + lado, y0], [x0, y0 + lado], [x0 + lado, y0 + lado]], float)


def test_maior_rosto_sem_mediapipe():
    from entrada.rosto import indice_do_maior_rosto, maior_rosto
    pequeno, grande = quadrado(0, 0, 30), quadrado(100, 100, 90)
    assert maior_rosto([pequeno, grande]) is grande
    assert indice_do_maior_rosto([pequeno, grande]) == 1
    assert maior_rosto([]) is None and indice_do_maior_rosto([]) is None


# ---- test_mapa -------------------------------------------------------------

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


# ---- test_estado_rosto -----------------------------------------------------

LIMIARES = LimiaresRosto(ear_olho_fechado=0.18, piscada_max_ms=400, olhos_fechados_alerta_ms=1000,
                         abertura_boca_aberta=0.40, bocejo_min_ms=1500)
ABERTO, FECHADO = 0.30, 0.05
BOCA_FECHADA, BOCA_ABERTA = 0.02, 0.60


def sequencia(monitor, passos):
    """Aplica (t_ms, ear, abertura) e devolve todos os eventos, com o instante."""
    eventos = []
    for t, ear, boca in passos:
        estado = monitor.registrar(t, ear, boca, "frente")
        eventos += [(t, e) for e in estado.eventos]
    return eventos


def test_olhos_abertos_e_boca_fechada_nao_geram_evento():
    monitor = MonitorRosto(LIMIARES)
    estado = monitor.registrar(0, ABERTO, BOCA_FECHADA, "frente")
    assert (estado.olhos, estado.boca, estado.eventos) == ("abertos", "fechada", [])
    assert sequencia(monitor, [(t, ABERTO, BOCA_FECHADA) for t in range(50, 3000, 50)]) == []


def test_piscada_curta():
    monitor = MonitorRosto(LIMIARES)
    passos = [(0, ABERTO, BOCA_FECHADA), (50, FECHADO, BOCA_FECHADA), (100, FECHADO, BOCA_FECHADA),
              (200, ABERTO, BOCA_FECHADA)]
    assert sequencia(monitor, passos) == [(200, "piscada (0,15 s)")]


def test_olhos_fechados_por_mais_de_1_s_avisam_durante_e_ao_reabrir():
    monitor = MonitorRosto(LIMIARES)
    passos = [(0, ABERTO, BOCA_FECHADA)] + [(t, FECHADO, BOCA_FECHADA) for t in range(100, 1400, 100)]
    passos.append((1400, ABERTO, BOCA_FECHADA))
    assert sequencia(monitor, passos) == [(1100, "olhos fechados há mais de 1 s"),
                                          (1400, "olhos reabertos após 1,30 s")]


def test_bocejo_so_com_a_boca_aberta_por_tempo_suficiente():
    monitor = MonitorRosto(LIMIARES)
    fala = [(t, ABERTO, BOCA_ABERTA) for t in range(0, 600, 100)] + [(600, ABERTO, BOCA_FECHADA)]
    assert sequencia(monitor, fala) == []                     # boca aberta 0,6 s: fala, não bocejo
    bocejo = [(t, ABERTO, BOCA_ABERTA) for t in range(1000, 3200, 100)] + [(3200, ABERTO, BOCA_FECHADA)]
    assert sequencia(monitor, bocejo) == [(2500, "bocejo")]   # avisa uma vez, ao passar de 1,5 s


def test_sem_rosto_zera_o_acompanhamento():
    monitor = MonitorRosto(LIMIARES)
    monitor.registrar(0, FECHADO, BOCA_FECHADA, "frente")
    assert monitor.registrar(100, None, None, None).olhos is None   # rosto sumiu
    assert monitor.registrar(200, ABERTO, BOCA_FECHADA, "frente").eventos == []  # sem "piscada"


def test_formatar_estado():
    monitor = MonitorRosto(LIMIARES)
    assert formatar_estado(monitor.registrar(0, 0.3126, 0.0213, "baixo")) == \
        "olhos abertos (EAR 0,31) · boca fechada (0,02) · cabeça baixo"
    assert formatar_estado(monitor.registrar(50, None, None, None)) == "rosto não detectado"


def test_medidas_usam_a_mesma_geometria_das_metricas():
    rng = np.random.default_rng(1)
    pts = rng.uniform(0, 200, (478, 2))
    ear, boca = medidas(pts, INDICES)
    esperado_ear = (geometria.ear(pts[INDICES["olho_esquerdo"]])
                    + geometria.ear(pts[INDICES["olho_direito"]])) / 2
    a, b = INDICES["boca_cantos"]
    esperado_boca = geometria.abertura_boca(
        [(pts[x], pts[y]) for x, y in INDICES["boca_pares_verticais"]], pts[a], pts[b])
    assert (ear, boca) == pytest.approx((esperado_ear, esperado_boca))


def test_configuracao_traz_os_limiares():
    from entrada.contexto import carregar_config
    LimiaresRosto(**carregar_config()["rosto"])
