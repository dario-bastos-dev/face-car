"""A calibração só entra em uso com melhoria mensurada fora do trecho alerta."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

from estimador.calibracao import avaliar_calibracao, propor_calibracao

RAIZ = Path(__file__).resolve().parents[2]


@pytest.fixture
def config():
    return json.loads((RAIZ / "config/estimador.json").read_text(encoding="utf-8"))


@pytest.fixture
def dados():
    return json.loads((RAIZ / "testes/casos/calibracao.json").read_text(encoding="utf-8"))


def test_proposta_preserva_ancoras_fechadas_e_nao_muda_entrada(config, dados):
    antes = deepcopy(config)
    metricas = dados["calibracoes"]["alta"]
    original = deepcopy(metricas)
    proposta = propor_calibracao(metricas, config)
    assert proposta["apta"]
    assert proposta["motivo"] == "aguardando_validacao_independente"
    assert proposta["config"]["olhos"]["ear_aberto_esq"] == 0.45
    for lado in ("esq", "dir"):
        assert proposta["config"]["olhos"][f"ear_fechado_{lado}"] == antes["olhos"][f"ear_fechado_{lado}"]
    assert config == antes and metricas == original


def test_adota_apenas_melhora_demonstrada(config, dados):
    resultado = avaliar_calibracao(dados["calibracoes"]["alta"], dados["validacoes"]["ganho"], config)
    assert resultado["adotada"]
    assert resultado["comparacao"]["mse_original"] == pytest.approx(0.5)
    assert resultado["comparacao"]["mse_calibrado"] == 0
    assert resultado["config"]["olhos"]["ear_aberto_esq"] == 0.45
    assert config["olhos"]["ear_aberto_esq"] == 0.3


@pytest.mark.parametrize("calibracao,validacao,motivo", [
    ("baixa", "piora", "piora_em_caso_de_validacao"),
    ("igual", "igual", "ganho_insuficiente"),
])
def test_rejeita_piora_e_empate(config, dados, calibracao, validacao, motivo):
    resultado = avaliar_calibracao(dados["calibracoes"][calibracao], dados["validacoes"][validacao], config)
    assert not resultado["adotada"]
    assert resultado["motivo"] == motivo
    assert resultado["config"] == config


def test_sem_validacao_nao_adota(config, dados):
    resultado = avaliar_calibracao(dados["calibracoes"]["alta"], [], config)
    assert not resultado["adotada"]
    assert resultado["motivo"] == "validacao_ausente"
    assert resultado["config"] == config


def test_exige_casos_abertos_e_fechados(config, dados):
    resultado = avaliar_calibracao(dados["calibracoes"]["alta"], dados["validacoes"]["ganho"][:1], config)
    assert not resultado["adotada"]
    assert resultado["motivo"] == "validacao_sem_abertos_e_fechados"


@pytest.mark.parametrize("corte", [0, 1, 20])
def test_trecho_curto_nao_gera_proposta(config, dados, corte):
    resultado = propor_calibracao(dados["calibracoes"]["alta"][:corte], config)
    assert not resultado["apta"]
    assert resultado["config"] is None


def test_nao_aprende_olhos_fechados_como_abertos(config, dados):
    resultado = propor_calibracao(dados["calibracoes"]["fechada"], config)
    assert not resultado["apta"]
    assert resultado["motivo"] == "referencia_aberta_implausivel"


def test_rejeita_rastreio_instavel(config, dados):
    metricas = dados["calibracoes"]["alta"]
    for indice, metrica in enumerate(metricas):
        metrica["ear_esq"] = 0.16 if indice % 2 == 0 else 0.45
    resultado = propor_calibracao(metricas, config)
    assert not resultado["apta"]
    assert resultado["motivo"] == "rastreio_instavel"


def test_exige_cobertura_temporal(config, dados):
    metricas = dados["calibracoes"]["alta"]
    for metrica in metricas[5:10]:
        metrica["rosto_visivel"] = False
    resultado = propor_calibracao(metricas, config)
    assert not resultado["apta"]
    assert resultado["motivo"] == "cobertura_insuficiente"


def test_rejeita_validacao_sem_confianca(config, dados):
    casos = dados["validacoes"]["ganho"]
    for metrica in casos[0]["metricas"]:
        metrica["confianca"] = 0.2
    resultado = avaliar_calibracao(dados["calibracoes"]["alta"], casos, config)
    assert not resultado["adotada"]
    assert resultado["motivo"] == "validacao_sem_evidencia_suficiente"


def test_um_caso_pior_nao_e_ocultado_pela_media(config, dados):
    casos = dados["validacoes"]["ganho"]
    casos.extend([deepcopy(casos[1]), deepcopy(casos[1])])
    casos[-1]["perclos_esperado"] = 0
    resultado = avaliar_calibracao(dados["calibracoes"]["alta"], casos, config)
    assert resultado["comparacao"]["ganho"] > 0
    assert not resultado["adotada"]
    assert resultado["motivo"] == "piora_em_caso_de_validacao"


def test_ganho_minimo_e_configuravel(config, dados):
    config["calibracao"]["ganho_minimo"] = 0.6
    resultado = avaliar_calibracao(dados["calibracoes"]["alta"], dados["validacoes"]["ganho"], config)
    assert not resultado["adotada"]
    assert resultado["motivo"] == "ganho_insuficiente"


@pytest.mark.parametrize("alvo", [-0.1, 1.1, float("nan"), True, None])
def test_rejeita_rotulo_invalido(config, dados, alvo):
    dados["validacoes"]["ganho"][0]["perclos_esperado"] = alvo
    with pytest.raises(ValueError, match="perclos_esperado"):
        avaliar_calibracao(dados["calibracoes"]["alta"], dados["validacoes"]["ganho"], config)


def test_rejeita_tempo_invertido(config, dados):
    with pytest.raises(ValueError):
        propor_calibracao(list(reversed(dados["calibracoes"]["alta"])), config)


@pytest.mark.parametrize("parametro,valor", [
    ("duracao_minima_ms", 0), ("min_amostras", 2.5),
    ("cobertura_minima", 1.1), ("cv_maximo", float("nan")),
    ("ganho_minimo", -1), ("ear_aberto_minimo", 0.6),
])
def test_rejeita_parametros_invalidos(config, dados, parametro, valor):
    config["calibracao"][parametro] = valor
    with pytest.raises(ValueError):
        propor_calibracao(dados["calibracoes"]["alta"], config)
