"""Métricas faciais: confiança do rastreio, extrator com o MediaPipe e paridade com o navegador.

A paridade leva cerca de meio minuto e precisa de Node e Chrome; rode com
RODAR_PARIDADE=1 uv run pytest testes/entrada/test_metricas.py
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from entrada.contrato import RAIZ, EscritorMetricas
from entrada.metricas import Estabilidade, ParametrosConfianca
from entrada.metricas_cli import comparar


# ---- test_confianca --------------------------------------------------------

CASOS = json.loads((Path(__file__).parents[1] / "casos" / "geometria.json").read_text())


def test_sequencia_compartilhada():
    caso = CASOS["estabilidade"]
    estab = Estabilidade(ParametrosConfianca(**caso["parametros"]))
    for q in caso["quadros"]:
        pts = None if q["pontos"] is None else np.array(q["pontos"])
        ref = caso["distancia_ref"] if pts is not None else 0.0
        assert estab.atualizar(pts, q["t_ms"], ref) == pytest.approx(q["esperado"], abs=1e-12)


def test_regras_basicas():
    p = ParametrosConfianca()
    estab = Estabilidade(p)
    pts = np.random.default_rng(3).uniform(0, 100, (15, 2))
    assert estab.atualizar(pts, 0, 60) == p.valor_inicial
    assert estab.atualizar(pts + 5, 33, 60) == pytest.approx(1.0)
    assert estab.atualizar(None, 67, 0) == 0.0
    assert estab.atualizar(pts, 100, 60) == p.valor_inicial
    # Lacuna maior que o intervalo máximo reinicia o histórico.
    assert estab.atualizar(pts, 100 + p.intervalo_max_ms + 1, 60) == p.valor_inicial


def test_tremor_reduz_confianca():
    rng = np.random.default_rng(4)
    pts = rng.uniform(0, 100, (15, 2))
    estab = Estabilidade(ParametrosConfianca())
    estab.atualizar(pts, 0, 60)
    confiancas = [estab.atualizar(pts + rng.normal(0, 2, pts.shape), 33 * i, 60) for i in range(1, 10)]
    assert confiancas[-1] < 0.5


# ---- test_extrator ---------------------------------------------------------

VIDEO = RAIZ / "testes" / "dados" / "retrato.mp4"
MODELO = RAIZ / "modelos" / "face_landmarker.task"

precisa_dados = pytest.mark.skipif(
    not (VIDEO.exists() and MODELO.exists()),
    reason="rode scripts/preparar.sh para baixar o modelo e gerar o vídeo",
)


@pytest.fixture(scope="module")
def registros():
    from entrada.metricas import ExtratorVideo
    from entrada.fontes import FonteArquivo

    config = json.loads((RAIZ / "config" / "extrator.json").read_text())
    with FonteArquivo(VIDEO) as fonte, ExtratorVideo(config) as extrator:
        return [extrator.processar(q, t, i) for q, t, i in fonte]


@precisa_dados
def test_um_registro_por_quadro(registros):
    assert [r.quadro for r in registros] == list(range(120))
    assert registros[30].t_ms == 1000


@precisa_dados
def test_rosto_ausente_na_tela_preta(registros):
    # O vídeo fica preto entre 1 s e 1,5 s (quadros 30 a 45).
    for r in registros[30:46]:
        assert not r.rosto_visivel and r.confianca == 0 and r.ear_esq is None
    assert all(r.rosto_visivel for r in registros[:30] + registros[46:])


@precisa_dados
def test_metricas_plausiveis(registros):
    for r in (r for r in registros if r.rosto_visivel):
        assert 0.1 < r.ear_esq < 0.45 and 0.1 < r.ear_dir < 0.45
        assert 0 <= r.abertura_boca < 1
        assert 0 <= r.confianca <= 1


@precisa_dados
def test_confianca_reinicia_ao_reencontrar_o_rosto(registros):
    assert registros[0].confianca == 0.5
    assert registros[46].confianca == 0.5
    assert registros[29].confianca > 0.9  # imagem parada: pontos estáveis


@precisa_dados
def test_roll_acompanha_a_rotacao(registros):
    # Entre 2 e 4 s a imagem gira 0,35·sin(2π(t-2)/2) rad no sentido horário,
    # máximo horário em t=2,5 s (quadro 75) e anti-horário em t=3,5 s (quadro 105).
    base = registros[10].roll
    assert registros[75].roll - base < -15
    assert registros[105].roll - base > 15


@precisa_dados
def test_modo_ao_vivo_em_tempo_real():
    """Envia o vídeo a 30 q/s ao modo assíncrono, como faria a webcam."""
    import threading
    import time

    from entrada.metricas import ExtratorAoVivo
    from entrada.fontes import FonteArquivo

    config = json.loads((RAIZ / "config" / "extrator.json").read_text())
    t0 = time.monotonic()
    relogio = lambda: (time.monotonic() - t0) * 1000
    recebidos, trava = [], threading.Lock()

    def ao_registrar(r):
        with trava:
            recebidos.append(r)

    with FonteArquivo(VIDEO) as fonte, ExtratorAoVivo(config, ao_registrar, relogio) as extrator:
        for quadro, _, indice in fonte:
            extrator.enviar(quadro, int(relogio()), indice)
            time.sleep(1 / 30)
        time.sleep(0.5)

    assert 0 < len(recebidos) <= 120
    ts = [r.t_ms for r in recebidos]
    assert ts == sorted(ts) and len(set(ts)) == len(ts)
    assert all(r.quadro >= 0 and r.atraso_ms > 0 for r in recebidos)
    # A tela preta (quadros 30 a 45) continua sem rosto no modo ao vivo.
    assert all(not r.rosto_visivel for r in recebidos if 30 <= r.quadro <= 45)


# ---- test_paridade_navegador -----------------------------------------------

DADOS = RAIZ / "testes" / "dados"

precisa_paridade = pytest.mark.skipif(
    os.environ.get("RODAR_PARIDADE") != "1" or not shutil.which("node") or not VIDEO.exists(),
    reason="defina RODAR_PARIDADE=1 (precisa de Node, Chrome e scripts/preparar.sh)",
)


@precisa_paridade
@pytest.mark.parametrize("nome", ["retrato.mp4", "retrato25.mp4"])
def test_python_e_navegador_dao_as_mesmas_metricas(tmp_path, nome):
    from entrada.metricas import ExtratorVideo
    from entrada.fontes import FonteArquivo

    config = json.loads((RAIZ / "config" / "extrator.json").read_text())
    video = DADOS / nome
    py, js = tmp_path / "py.csv", tmp_path / "js.csv"
    with FonteArquivo(video) as fonte, ExtratorVideo(config) as extrator, \
            EscritorMetricas(py) as escritor:
        for q, t, i in fonte:
            escritor.escrever(extrator.processar(q, t, i))
    subprocess.run(["node", str(RAIZ / "scripts" / "extrair_navegador.mjs"), str(video), str(js)],
                   check=True, timeout=600)

    r = comparar(py, js)
    assert r["alertas"] == []
    assert r["quadros_comuns"] == r["quadros_a"] == r["quadros_b"]
    assert r["concordancia_rosto"] >= 0.99
    d = r["diferencas"]
    for nome in ("ear_esq", "ear_dir", "abertura_boca"):
        assert d[nome]["p95"] < 0.01, nome
    for nome in ("yaw", "pitch", "roll"):
        assert d[nome]["p95"] < 1.0, nome
    assert d["confianca"]["p95"] < 0.05
