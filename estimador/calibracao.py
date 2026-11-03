"""Calibração opcional, offline, sem câmera e sem alteração automática de arquivos.

``metricas_alerta`` deve ser uma gravação identificada pelo responsável como
motorista alerta. Os casos de validação precisam vir de gravações independentes,
com PERCLOS de referência anotado; não use o trecho de calibração para validá-lo.
O EAR é apenas uma aproximação da abertura palpebral. Um trecho alerta estima
somente a referência de olho aberto, nunca a referência de olho fechado.
"""

from copy import deepcopy
import math

import numpy as np

from estimador.nucleo import estimar, observacao_valida
from estimador.config import numero


def _validar_parametros(config):
    parametros = config.get("calibracao", {})
    for nome, minimo, maximo in (
        ("duracao_minima_ms", 1, 86400000),
        ("min_amostras", 2, 1000000),
        ("cobertura_minima", 0, 1),
        ("cv_maximo", 0, 1),
        ("ganho_minimo", 0, 1),
    ):
        valor = parametros.get(nome)
        if not numero(valor) or not minimo <= valor <= maximo:
            raise ValueError(f"Parâmetro de calibração inválido: {nome}")
    if int(parametros["min_amostras"]) != parametros["min_amostras"]:
        raise ValueError("min_amostras deve ser inteiro")
    minimo = parametros.get("ear_aberto_minimo", 0.15)
    maximo = parametros.get("ear_aberto_maximo", 0.5)
    if not numero(minimo) or not numero(maximo) or not 0 < minimo < maximo <= 1:
        raise ValueError("Limites de EAR aberto da calibração inválidos")
    return parametros


def propor_calibracao(metricas_alerta, config):
    """Retorna uma configuração candidata, ainda não aprovada para uso.

    A mediana reduz o efeito de piscadas ocasionais. A qualidade exige duração,
    quantidade, cobertura temporal, estabilidade e referências plausíveis.
    A configuração original nunca é modificada.
    """
    metricas = list(metricas_alerta)
    parametros = _validar_parametros(config)
    estimar(metricas, config)  # também valida a ordem temporal
    resultado = {"apta": False, "motivo": "dados_insuficientes", "config": None}
    if not metricas:
        return resultado
    duracao = metricas[-1]["t_ms"] - metricas[0]["t_ms"]
    validas = [m for m in metricas if observacao_valida(m, config)]
    # Calibração cobre o trecho inteiro, mesmo quando ele supera a janela usual.
    cobertura_config = deepcopy(config)
    cobertura_config["janela_s"] = max(config["janela_s"], duracao / 1000)
    resumo = estimar(metricas, cobertura_config)
    resultado["qualidade"] = {
        "duracao_ms": duracao,
        "amostras_validas": len(validas),
        "cobertura": resumo["cobertura"],
    }
    if duracao < parametros["duracao_minima_ms"] or len(validas) < parametros["min_amostras"]:
        return resultado
    if resumo["cobertura"] < parametros["cobertura_minima"]:
        resultado["motivo"] = "cobertura_insuficiente"
        return resultado
    candidata = deepcopy(config)
    referencias = {}
    for lado in ("esq", "dir"):
        valores = np.asarray([m[f"ear_{lado}"] for m in validas], dtype=float)
        mediana = float(np.median(valores))
        mad = float(np.median(np.abs(valores - mediana)))
        cv = 1.4826 * mad / mediana if mediana > 0 else math.inf
        referencias[lado] = {"mediana": mediana, "cv_robusto": cv if math.isfinite(cv) else None}
        resultado["referencias"] = referencias
        minimo = parametros.get("ear_aberto_minimo", 0.15)
        maximo = parametros.get("ear_aberto_maximo", 0.5)
        if not minimo <= mediana <= maximo or mediana <= config["olhos"][f"ear_fechado_{lado}"]:
            resultado["motivo"] = "referencia_aberta_implausivel"
            return resultado
        if cv > parametros["cv_maximo"]:
            resultado["motivo"] = "rastreio_instavel"
            return resultado
        candidata["olhos"][f"ear_aberto_{lado}"] = mediana
    resultado.update(apta=True, motivo="aguardando_validacao_independente", config=candidata)
    return resultado


def avaliar_calibracao(metricas_alerta, casos_validacao, config):
    """Só adota a proposta se melhorar a validação e não piorar nenhum caso.

    Cada caso é ``{id?: str, metricas: [...], perclos_esperado: float}``.
    Exige pelo menos um caso de olhos abertos (0) e um de fechados (1), além
    de confiança suficiente nas duas configurações. Compara MSE de PERCLOS,
    não acurácia clínica, e devolve a configuração escolhida em ``config``.
    """
    proposta = propor_calibracao(metricas_alerta, config)
    resultado = {
        "adotada": False,
        "motivo": proposta["motivo"],
        "config": deepcopy(config),
        "proposta": proposta,
        "comparacao": None,
    }
    if not proposta["apta"]:
        return resultado
    casos = list(casos_validacao)
    if not casos:
        resultado["motivo"] = "validacao_ausente"
        return resultado
    alvos = []
    for caso in casos:
        alvo = caso.get("perclos_esperado")
        if not numero(alvo) or not 0 <= alvo <= 1:
            raise ValueError("perclos_esperado deve ser um número finito entre 0 e 1")
        alvos.append(float(alvo))
    if 0.0 not in alvos or 1.0 not in alvos:
        resultado["motivo"] = "validacao_sem_abertos_e_fechados"
        return resultado
    confianca_minima = config["politica"]["confianca_minima"]
    comparacoes = []
    for indice, (caso, alvo) in enumerate(zip(casos, alvos)):
        baseline = estimar(caso["metricas"], config)
        calibrado = estimar(caso["metricas"], proposta["config"])
        if any(e["perclos"] is None or e["confianca"] < confianca_minima for e in (baseline, calibrado)):
            resultado["motivo"] = "validacao_sem_evidencia_suficiente"
            return resultado
        comparacoes.append({
            "id": caso.get("id", str(indice)),
            "perclos_esperado": alvo,
            "perclos_original": baseline["perclos"],
            "perclos_calibrado": calibrado["perclos"],
            "erro_original": (baseline["perclos"] - alvo) ** 2,
            "erro_calibrado": (calibrado["perclos"] - alvo) ** 2,
        })
    mse_original = float(np.mean([c["erro_original"] for c in comparacoes]))
    mse_calibrado = float(np.mean([c["erro_calibrado"] for c in comparacoes]))
    ganho = mse_original - mse_calibrado
    resultado["comparacao"] = {
        "metrica": "erro_quadratico_medio_perclos",
        "mse_original": mse_original,
        "mse_calibrado": mse_calibrado,
        "ganho": ganho,
        "casos": comparacoes,
    }
    if any(c["erro_calibrado"] > c["erro_original"] + 1e-12 for c in comparacoes):
        resultado["motivo"] = "piora_em_caso_de_validacao"
    elif ganho <= 0 or ganho + 1e-12 < config["calibracao"]["ganho_minimo"]:
        resultado["motivo"] = "ganho_insuficiente"
    else:
        resultado.update(adotada=True, motivo="melhora_na_validacao", config=proposta["config"])
    return resultado
