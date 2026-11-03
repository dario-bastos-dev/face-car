import copy
import json
from pathlib import Path

import pytest

from estimador import carregar_config, estimar

RAIZ = Path(__file__).resolve().parents[2]
CASOS = json.loads((RAIZ / "testes/casos/estimador.json").read_text(encoding="utf-8"))["casos"]


def mesclar(base, patch):
    novo = copy.deepcopy(base)
    for k, v in patch.items():
        novo[k] = mesclar(novo[k], v) if isinstance(v, dict) else v
    return novo


@pytest.mark.parametrize("caso", CASOS, ids=lambda c: c["nome"])
def test_casos_compartilhados(caso):
    cfg = mesclar(carregar_config(), caso.get("config_patch", {}))
    original = copy.deepcopy((caso, cfg))
    resultado = estimar(caso["metricas"], cfg, caso.get("agora_ms"))
    for chave, esperado in caso["esperado"].items():
        if esperado is None:
            assert resultado[chave] is None
        else:
            assert resultado[chave] == pytest.approx(esperado, abs=1e-9)
    assert (caso, cfg) == original


@pytest.mark.parametrize("tempo", [-1, True, 0.5, float("nan"), float("inf"), 2**53])
def test_tempo_invalido(tempo):
    with pytest.raises(ValueError):
        estimar([{"t_ms": tempo}], carregar_config())


@pytest.mark.parametrize("tempos", [[0, 0], [100, 0]])
def test_ordem_invalida(tempos):
    with pytest.raises(ValueError):
        estimar([{"t_ms": t} for t in tempos], carregar_config())


def test_futuro():
    with pytest.raises(ValueError):
        estimar([{"t_ms": 100}], carregar_config(), 99)


@pytest.mark.parametrize("campo,valor", [("ear_esq", None), ("ear_dir", -1),
    ("ear_esq", float("nan")), ("confianca", 2), ("confianca", .49),
    ("atraso_ms", None), ("atraso_ms", 501), ("rosto_visivel", "1")])
def test_metrica_invalida_nao_vira_olho_aberto(campo, valor):
    metrica = {"t_ms": 0, "rosto_visivel": True, "ear_esq": .3, "ear_dir": .3,
               "confianca": 1, "atraso_ms": 0, campo: valor}
    r = estimar([metrica], carregar_config(), 200)
    assert r["indice"] is None
    assert r["perclos"] is None
    assert r["confianca"] == 0


@pytest.mark.parametrize("patch", [{"janela_s": 0}, {"max_intervalo_ms": -1},
    {"min_evidencia_ms": 0}, {"min_fechamento_ms": -1},
    {"olhos": {"ear_aberto_esq": .05}}, {"olhos": {"fechamento_limiar": 2}}])
def test_config_invalida(patch):
    with pytest.raises(ValueError):
        estimar([], mesclar(carregar_config(), patch))
