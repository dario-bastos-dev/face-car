import json
from pathlib import Path

import numpy as np
import pytest

from entrada import geometria

CASOS = json.loads((Path(__file__).parents[1] / "casos" / "geometria.json").read_text())


@pytest.mark.parametrize("caso", CASOS["ear"], ids=lambda c: c["nome"])
def test_ear(caso):
    assert geometria.ear(np.array(caso["pontos"])) == pytest.approx(caso["esperado"], abs=1e-9)


@pytest.mark.parametrize("caso", CASOS["abertura_boca"], ids=lambda c: c["nome"])
def test_abertura_boca(caso):
    pares = [(np.array(a), np.array(b)) for a, b in caso["pares"]]
    a, b = caso["cantos"]
    assert geometria.abertura_boca(pares, a, b) == pytest.approx(caso["esperado"], abs=1e-9)


@pytest.mark.parametrize("caso", CASOS["pose"], ids=lambda c: str(c["esperado"]))
def test_angulos_da_matriz(caso):
    yaw, pitch, roll = geometria.angulos_da_matriz(caso["matriz"])
    e = caso["esperado"]
    assert (yaw, pitch, roll) == pytest.approx((e["yaw"], e["pitch"], e["roll"]), abs=1e-6)


def test_residuo_zero_para_movimento_rigido():
    rng = np.random.default_rng(1)
    a = rng.uniform(0, 50, (12, 2))
    c, s = np.cos(0.4), np.sin(0.4)
    b = 1.7 * a @ np.array([[c, -s], [s, c]]).T + [10, -5]
    assert geometria.residuo_alinhado(a, b) == pytest.approx(0, abs=1e-9)


def test_residuo_cresce_com_o_ruido():
    rng = np.random.default_rng(2)
    a = rng.uniform(0, 50, (12, 2))
    pequeno = geometria.residuo_alinhado(a, a + rng.normal(0, 0.1, a.shape))
    grande = geometria.residuo_alinhado(a, a + rng.normal(0, 2.0, a.shape))
    assert 0 < pequeno < grande
