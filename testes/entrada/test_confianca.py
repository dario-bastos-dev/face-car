import json
from pathlib import Path

import numpy as np
import pytest

from entrada.confianca import Estabilidade, ParametrosConfianca

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
