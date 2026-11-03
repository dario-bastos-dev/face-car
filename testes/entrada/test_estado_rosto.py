import numpy as np
import pytest

from entrada import geometria
from entrada.contexto import carregar_pontos_rosto
from entrada.estado_rosto import LimiaresRosto, MonitorRosto, formatar_estado, medidas

INDICES = carregar_pontos_rosto()
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
