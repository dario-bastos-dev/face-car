"""Casos contratuais da tabela, também executados pelo Node."""
import copy
import json
from pathlib import Path

import pytest

from estimador.politica import estado_inicial, transicionar

RAIZ = Path(__file__).resolve().parents[2]
CONFIG = json.loads((RAIZ / "config/estimador.json").read_text(encoding="utf-8"))
CASOS = json.loads((RAIZ / "testes/casos/politica.json").read_text(encoding="utf-8"))["casos"]


@pytest.mark.parametrize("caso", CASOS, ids=lambda c: c["nome"])
def test_transicoes_compartilhadas(caso):
    estado = estado_inicial()
    estado.update(nome=caso["inicial"], inicio_ms=0,
                  prazo_resposta_em_ms=CONFIG["politica"]["prazo_resposta_ms"]
                  if caso["inicial"] == "ALERTA" else None)
    for passo in caso["passos"]:
        estimativa = {"t_ms": passo.get("estimativa_t_ms", passo["t_ms"]),
                      "indice": passo["indice"], "confianca": passo["confianca"]}
        antes = copy.deepcopy((estado, estimativa, CONFIG))
        proximo = transicionar(estado, estimativa, passo["t_ms"], CONFIG,
                               passo.get("resposta_motorista", False))
        assert proximo["nome"] == passo["estado_esperado"], passo
        assert (estado, estimativa, CONFIG) == antes
        estado = proximo


def test_todas_as_transicoes_da_configuracao_tem_caso():
    pares = set()
    for caso in CASOS:
        anterior = caso["inicial"]
        for passo in caso["passos"]:
            atual = passo["estado_esperado"]
            if atual != anterior:
                pares.add((anterior, atual))
            anterior = atual
    for linha in CONFIG["politica"]["transicoes"]:
        if linha["de"] == "*":
            assert all((s, linha["para"]) in pares for s in
                       ("NORMAL", "ATENCAO", "ALERTA", "INTERVENCAO"))
        else:
            assert (linha["de"], linha["para"]) in pares


@pytest.mark.parametrize("indice,confianca,t_ms", [
    (float("nan"), 1, 0), (100, float("inf"), 0), (101, 1, 0),
    (20, 1.01, 0), (20, 1, 1), (True, 1, 0), (20, True, 0),
])
def test_evidencia_invalida_degrada(indice, confianca, t_ms):
    estado = estado_inicial()
    estado["nome"] = "INTERVENCAO"
    saida = transicionar(estado, dict(indice=indice, confianca=confianca, t_ms=t_ms), 0, CONFIG)
    assert saida["nome"] == "DEGRADADO"


def test_rejeita_relogio_regressivo():
    estado = transicionar(estado_inicial(), dict(indice=0, confianca=1, t_ms=100), 100, CONFIG)
    with pytest.raises(ValueError, match="fora de ordem"):
        transicionar(estado, dict(indice=0, confianca=1, t_ms=99), 99, CONFIG)


@pytest.mark.parametrize("tempo", [-1, 1.5, True, 2**53])
def test_rejeita_tempo_invalido(tempo):
    with pytest.raises(ValueError):
        transicionar(estado_inicial(), dict(indice=0, confianca=1, t_ms=0), tempo, CONFIG)


def test_resposta_com_dados_ruins_nao_impede_degradacao():
    estado = estado_inicial()
    estado.update(nome="ALERTA", prazo_resposta_em_ms=5000)
    saida = transicionar(estado, dict(indice=90, confianca=0, t_ms=5000), 5000, CONFIG, True)
    assert saida["nome"] == "DEGRADADO"
    assert saida["prazo_resposta_em_ms"] is None


def test_tempo_inteiro_aceita_representacao_float_como_javascript():
    estado = estado_inicial()
    estado["nome"] = "NORMAL"
    saida = transicionar(estado, dict(t_ms=10.0, indice=20, confianca=1), 10.0, CONFIG)
    assert saida["nome"] == "NORMAL"


@pytest.mark.parametrize("chave,valor", [
    ("confianca_minima", -0.1), ("confianca_minima", 0),
    ("confianca_minima", float("nan")), ("confianca_minima", 1.1),
    ("validade_estimativa_ms", -1), ("intervalo_maximo_ms", 0),
    ("prazo_resposta_ms", 0), ("prazo_resposta_ms", 0.5),
    ("prazo_resposta_ms", True), ("transicoes", []),
])
def test_rejeita_parametros_inseguros(chave, valor):
    config = copy.deepcopy(CONFIG)
    config["politica"][chave] = valor
    with pytest.raises(ValueError):
        transicionar(estado_inicial(), dict(t_ms=0, indice=0, confianca=1), 0, config)


@pytest.mark.parametrize("linha,chave,valor", [
    (0, "duracao_ms", 1), (0, "de", "NORMAL"), (0, "para", "NORMAL"),
    (1, "limiar", 101), (1, "limiar", float("inf")),
    (1, "duracao_ms", -1), (1, "duracao_ms", True),
    (1, "de", "INEXISTENTE"), (1, "condicao", "INEXISTENTE"),
    (3, "para", "INTERVENCAO"), (7, "de", "NORMAL"),
])
def test_rejeita_tabela_insegura(linha, chave, valor):
    config = copy.deepcopy(CONFIG)
    config["politica"]["transicoes"][linha][chave] = valor
    with pytest.raises(ValueError):
        transicionar(estado_inicial(), dict(t_ms=0, indice=0, confianca=1), 0, config)
