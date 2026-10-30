"""Funções puras: métricas temporais -> índice heurístico e confiança.

EAR normalizado é uma aproximação da abertura palpebral, não uma medição
direta de cobertura da pupila. Os parâmetros são uma baseline experimental.
"""

import numpy as np

from .config import numero, validar_config


def validar_tempo(valor, nome="t_ms"):
    if not numero(valor) or valor < 0 or valor > 2**53 - 1 or int(valor) != valor:
        raise ValueError(f"{nome} deve ser inteiro não negativo e seguro em JavaScript")


def validar_sequencia(metricas, agora_ms=None):
    anterior = -1
    for m in metricas:
        if not isinstance(m, dict):
            raise ValueError("Métrica deve ser um objeto")
        t = m.get("t_ms")
        validar_tempo(t)
        if t <= anterior:
            raise ValueError("t_ms deve ser estritamente crescente")
        anterior = t
    agora = (metricas[-1]["t_ms"] if metricas else 0) if agora_ms is None else agora_ms
    validar_tempo(agora, "agora_ms")
    if anterior > agora:
        raise ValueError("Métrica no futuro em relação a agora_ms")
    return agora


def observacao_valida(metrica, config):
    rosto = metrica.get("rosto_visivel")
    if not (rosto is True or (numero(rosto) and rosto == 1)):
        return False
    for nome in ("ear_esq", "ear_dir"):
        if not numero(metrica.get(nome)) or not 0 <= metrica[nome] <= 1:
            return False
    conf, atraso = metrica.get("confianca"), metrica.get("atraso_ms")
    return (numero(conf) and config["confianca_rastreio_minima"] <= conf <= 1
            and numero(atraso) and 0 <= atraso <= config["max_atraso_ms"])


def olhos_fechados(metrica, config):
    olhos = config["olhos"]
    return all(
        (olhos[f"ear_aberto_{lado}"] - metrica[f"ear_{lado}"])
        / (olhos[f"ear_aberto_{lado}"] - olhos[f"ear_fechado_{lado}"])
        + 1e-12 >= olhos["fechamento_limiar"]
        for lado in ("esq", "dir")
    )


def estimar(metricas, config, agora_ms=None):
    """Integra suporte temporal limitado, sem usar FPS nem dados futuros.

    A amostra em t vale até a seguinte, no máximo max_intervalo_ms.
    PERCLOS usa apenas tempo válido; confiança penaliza cobertura e aquecimento.
    Piscar breve (< min_fechamento_ms) não entra no numerador. Toda a duração
    de um episódio passa a contar quando ele alcança esse mínimo.
    """
    validar_config(config)
    metricas = list(metricas)
    agora = validar_sequencia(metricas, agora_ms)
    inicio = max(metricas[0]["t_ms"] if metricas else agora,
                 agora - config["janela_s"] * 1000)
    duracoes, confiancas = [], []
    episodios = []
    episodio_inicio = episodio_fim = None
    ultimo_valido = ultimo_fechado = False
    for i, m in enumerate(metricas):
        t = m["t_ms"]
        proximo = metricas[i + 1]["t_ms"] if i + 1 < len(metricas) else agora
        fim = min(proximo, t + config["max_intervalo_ms"], agora)
        valido = observacao_valida(m, config)
        fechado = valido and olhos_fechados(m, config)
        dt = max(0, fim - max(t, inicio))
        if valido and dt > 0:
            duracoes.append(dt)
            confiancas.append(m["confianca"])
        if episodio_inicio is not None and (not fechado or t > episodio_fim):
            episodios.append((episodio_inicio, episodio_fim))
            episodio_inicio = episodio_fim = None
        if fechado:
            if episodio_inicio is None:
                episodio_inicio = t
            episodio_fim = fim
        ultimo_valido, ultimo_fechado = valido, fechado
    if episodio_inicio is not None:
        episodios.append((episodio_inicio, episodio_fim))

    tempo_valido = float(np.sum(duracoes))
    tempo_fechado = sum(max(0, fim - max(t, inicio)) for t, fim in episodios
                        if fim - t >= config["min_fechamento_ms"])
    tempo_janela = agora - inicio
    cobertura = min(1.0, tempo_valido / tempo_janela) if tempo_janela > 0 else 0.0
    atual = (bool(metricas) and ultimo_valido
             and agora - metricas[-1]["t_ms"] <= config["max_intervalo_ms"])
    continuo = (max(0, agora - max(episodio_inicio, inicio))
                if atual and ultimo_fechado and episodio_inicio is not None
                and episodio_fim == agora else 0)
    perclos = min(1.0, tempo_fechado / tempo_valido) if tempo_valido else None
    confianca_media = float(np.dot(duracoes, confiancas)) / tempo_valido if tempo_valido else 0
    confianca = (min(1.0, cobertura * confianca_media * min(1, tempo_valido / config["min_evidencia_ms"]))
                 if atual else 0.0)
    indice = (100 * max(perclos, min(1, continuo / config["saturacao_fechamento_ms"]))
              if perclos is not None else None)
    return {
        "t_ms": agora, "indice": indice, "confianca": confianca,
        "perclos": perclos, "fechamento_continuo_ms": continuo,
        "tempo_valido_ms": tempo_valido, "tempo_fechado_ms": tempo_fechado,
        "cobertura": cobertura, "amostras_validas": len(duracoes),
    }
