import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

from estimador.mensagens import emitir, estado_emissor_inicial
from estimador.politica import estado_inicial

RAIZ = Path(__file__).resolve().parents[2]
CONFIG = json.loads((RAIZ / "config/estimador.json").read_text(encoding="utf-8"))
CONTRATO = json.loads((RAIZ / "contratos/sinal.v1.json").read_text(encoding="utf-8"))
CASOS = json.loads((RAIZ / "testes/casos/mensagens.json").read_text(encoding="utf-8"))["casos"]
VALIDADOR = Draft202012Validator(CONTRATO)


@pytest.mark.parametrize("caso", CASOS, ids=lambda c: c["nome"])
def test_casos_compartilhados(caso):
    config = copy.deepcopy(CONFIG)
    if "mensagens" in caso:
        config["mensagens"] = caso["mensagens"]
    emissor = estado_emissor_inicial("teste-compartilhado")
    for passo in caso["passos"]:
        dado = dict(t_ms=passo.get("estimativa_t_ms", passo["t_ms"]),
                    indice=passo["indice"], confianca=passo["confianca"])
        emissor, mensagens = emitir(emissor, {"nome": passo["estado"]}, dado, passo["t_ms"], config)
        assert mensagens == passo["esperadas"]
        for mensagem in mensagens:
            VALIDADOR.validate(mensagem)


def estimativa(t, indice=70, confianca=1):
    return dict(t_ms=t, indice=indice, confianca=confianca)


def test_seq_ttl_heartbeat_renovacao_e_pureza():
    emissor, politica = estado_emissor_inicial("teste"), estado_inicial()
    politica["nome"] = "ALERTA"
    emitidas = []
    for t, tipos in [(0, ["acao", "heartbeat"]), (499, []),
                     (500, ["acao", "heartbeat"]), (501, [])]:
        antes = copy.deepcopy((emissor, politica, CONFIG))
        novo, mensagens = emitir(emissor, politica, estimativa(t), t, CONFIG)
        assert [m["tipo"] for m in mensagens] == tipos
        assert (emissor, politica, CONFIG) == antes
        assert all(m["ts"] == t and m["ttl"] == 2000 for m in mensagens)
        assert all(set(m) == set(CONTRATO["required"]) for m in mensagens)
        json.dumps(mensagens, allow_nan=False)
        emitidas.extend(mensagens)
        emissor = novo
    assert [m["seq"] for m in emitidas] == [1, 2, 3, 4]
    assert all(m["sessao"] == "teste" for m in emitidas)


def test_mudanca_emite_acao_sem_esperar_heartbeat():
    emissor, _ = emitir(estado_emissor_inicial(), {"nome": "NORMAL"}, estimativa(0), 0, CONFIG)
    _, mensagens = emitir(emissor, {"nome": "ALERTA"}, estimativa(1), 1, CONFIG)
    assert len(mensagens) == 1
    assert mensagens[0]["tipo"] == "acao"
    assert mensagens[0]["nivel"] == 2


def test_sem_novo_quadro_degrada_e_heartbeat_continua():
    emissor, _ = emitir(estado_emissor_inicial(), {"nome": "INTERVENCAO"}, estimativa(0), 0, CONFIG)
    emissor, mensagens = emitir(emissor, {"nome": "INTERVENCAO"}, estimativa(0), 251, CONFIG)
    assert mensagens[0]["estado"] == "DEGRADADO"
    assert mensagens[0]["acao"] == "sistema_degradado"
    assert mensagens[0]["indice"] is None
    assert mensagens[0]["confianca"] == 0
    _, mensagens = emitir(emissor, {"nome": "INTERVENCAO"}, estimativa(0), 500, CONFIG)
    assert [m["tipo"] for m in mensagens] == ["heartbeat"]
    assert mensagens[0]["estado"] == "DEGRADADO"


def test_heartbeat_tem_agenda_independente_da_renovacao():
    config = copy.deepcopy(CONFIG)
    config["mensagens"]["renovar_acao_ms"] = 1000
    emissor, _ = emitir(estado_emissor_inicial(), {"nome": "NORMAL"}, estimativa(0), 0, config)
    _, mensagens = emitir(emissor, {"nome": "NORMAL"}, estimativa(500), 500, config)
    assert [m["tipo"] for m in mensagens] == ["heartbeat"]


@pytest.mark.parametrize("nome,nivel,acao", [
    ("NORMAL", 0, "monitorar"), ("ATENCAO", 1, "aviso_visual"),
    ("ALERTA", 2, "alarme_sonoro"), ("INTERVENCAO", 3, "desacelerar_simulado"),
    ("DEGRADADO", 0, "sistema_degradado"),
])
def test_mapeamento_contrato(nome, nivel, acao):
    _, mensagens = emitir(estado_emissor_inicial(), {"nome": nome}, estimativa(0), 0, CONFIG)
    assert all(m["nivel"] == nivel and m["acao"] == acao for m in mensagens)


def test_rejeita_relogio_regressivo_e_sequencia_esgotada():
    emissor, _ = emitir(estado_emissor_inicial(), {"nome": "NORMAL"}, estimativa(10), 10, CONFIG)
    with pytest.raises(ValueError, match="fora de ordem"):
        emitir(emissor, {"nome": "NORMAL"}, estimativa(9), 9, CONFIG)
    emissor["seq"] = 2**53 - 1
    with pytest.raises(ValueError, match="esgotada"):
        emitir(emissor, {"nome": "NORMAL"}, estimativa(510), 510, CONFIG)


def test_nova_sessao_reinicia_seq():
    estado, mensagens = emitir(estado_emissor_inicial("sessao-nova"), {"nome": "NORMAL"}, estimativa(0), 0, CONFIG)
    assert estado["seq"] == 2
    assert mensagens[0]["seq"] == 1
    assert mensagens[0]["sessao"] == "sessao-nova"


def test_schema_valido_e_rejeita_acao_incompativel_com_estado():
    Draft202012Validator.check_schema(CONTRATO)
    _, mensagens = emitir(estado_emissor_inicial(), {"nome": "DEGRADADO"}, estimativa(0), 0, CONFIG)
    errado = dict(mensagens[0], acao="desacelerar_simulado", nivel=3)
    with pytest.raises(ValidationError):
        VALIDADOR.validate(errado)
    for campo, valor in [("seq", 0), ("ttl", 0), ("confianca", 1.1), ("indice", 101), ("ts", -1)]:
        with pytest.raises(ValidationError):
            VALIDADOR.validate(dict(mensagens[0], **{campo: valor}))


@pytest.mark.parametrize("chave,valor", [
    ("ttl_ms", 0), ("ttl_ms", 500), ("ttl_ms", -1),
    ("ttl_ms", float("inf")), ("heartbeat_ms", 0),
    ("heartbeat_ms", 2000), ("heartbeat_ms", 0.5),
    ("renovar_acao_ms", 2001), ("renovar_acao_ms", True),
])
def test_rejeita_configuracao_de_sinal_invalida(chave, valor):
    config = copy.deepcopy(CONFIG)
    config["mensagens"][chave] = valor
    with pytest.raises(ValueError):
        emitir(estado_emissor_inicial(), {"nome": "NORMAL"}, estimativa(0), 0, config)
