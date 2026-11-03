"""Paridade entre o extrator em Python e o do navegador no mesmo vídeo.

Leva cerca de meio minuto e precisa de Node e Chrome; rode com
RODAR_PARIDADE=1 uv run pytest testes/entrada/test_paridade_navegador.py
"""

import json
import os
import shutil
import subprocess

import pytest

from entrada.comparar import comparar
from entrada.contrato import RAIZ, EscritorMetricas

DADOS = RAIZ / "testes" / "dados"
VIDEO = DADOS / "retrato.mp4"

pytestmark = pytest.mark.skipif(
    os.environ.get("RODAR_PARIDADE") != "1" or not shutil.which("node") or not VIDEO.exists(),
    reason="defina RODAR_PARIDADE=1 (precisa de Node, Chrome e scripts/preparar.sh)",
)


@pytest.mark.parametrize("nome", ["retrato.mp4", "retrato25.mp4"])
def test_python_e_navegador_dao_as_mesmas_metricas(tmp_path, nome):
    from entrada.extrator import ExtratorVideo
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
