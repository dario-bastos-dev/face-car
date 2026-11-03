"""Emissão pura de ações e heartbeat; o chamador fornece os ticks da sessão."""

from copy import deepcopy

from .politica import ESTADOS, MAX_INTEIRO, evidencia_valida, validar_politica, validar_tempo

ACOES = {"NORMAL": (0, "monitorar"), "ATENCAO": (1, "aviso_visual"),
         "ALERTA": (2, "alarme_sonoro"), "INTERVENCAO": (3, "desacelerar_simulado"),
         "DEGRADADO": (0, "sistema_degradado")}


def validar_mensagens(config: dict) -> dict:
    m = config.get("mensagens")
    if not isinstance(m, dict):
        raise ValueError("Configuração mensagens ausente")
    for chave in ("ttl_ms", "heartbeat_ms", "renovar_acao_ms"):
        validar_tempo(m.get(chave), chave)
        if m[chave] == 0:
            raise ValueError(f"{chave} deve ser positivo")
    if max(m["heartbeat_ms"], m["renovar_acao_ms"]) >= m["ttl_ms"]:
        raise ValueError("Heartbeat e renovação devem ocorrer antes do TTL")
    return config


def estado_emissor_inicial(sessao: str = "replay") -> dict:
    if not isinstance(sessao, str) or not sessao.strip():
        raise ValueError("sessao deve ser uma string não vazia")
    return {"sessao": sessao, "seq": 0, "ultimo_ms": None,
            "ultima_acao_ms": None, "ultimo_heartbeat_ms": None, "ultimo_estado": None}


def emitir(estado_emissor: dict, estado_politica: dict, estimativa: dict,
           agora_ms: int, config: dict) -> tuple[dict, list[dict]]:
    """Retorna (novo_emissor, mensagens), com seq compartilhado pelos dois tipos.

    ts e ttl são milissegundos no relógio monotônico da sessão; o receptor
    precisa usar a mesma origem (ou sincronizá-la no transporte da Parte 3).
    Uma sessão nova reinicia seq. Chamadas atrasadas não fabricam heartbeats
    retroativos. Evidência expirada sempre emite estado DEGRADADO.
    """
    validar_politica(config)
    validar_mensagens(config)
    validar_tempo(agora_ms)
    validar_tempo(agora_ms + config["mensagens"]["ttl_ms"], "expiracao")
    if estado_politica.get("nome") not in ESTADOS:
        raise ValueError("Estado desconhecido")
    novo = deepcopy(estado_emissor)
    if novo["ultimo_ms"] is not None and agora_ms < novo["ultimo_ms"]:
        raise ValueError("Tempo do emissor fora de ordem")
    novo["ultimo_ms"] = agora_ms
    m = config["mensagens"]
    valido = evidencia_valida(estimativa, agora_ms, config)
    nome = estado_politica["nome"] if valido else "DEGRADADO"
    nivel, acao = ACOES[nome]
    mensagens = []

    def adicionar(tipo):
        if novo["seq"] >= MAX_INTEIRO:
            raise ValueError("Sequência esgotada; inicie outra sessão")
        novo["seq"] += 1
        mensagens.append({"versao": 1, "sessao": novo["sessao"], "tipo": tipo,
                          "seq": novo["seq"], "ts": agora_ms, "ttl": m["ttl_ms"],
                          "estado": nome, "nivel": nivel, "acao": acao,
                          "indice": estimativa["indice"] if valido else None,
                          "confianca": estimativa["confianca"] if valido else 0.0})

    if (novo["ultimo_estado"] != nome or novo["ultima_acao_ms"] is None
            or agora_ms - novo["ultima_acao_ms"] >= m["renovar_acao_ms"]):
        adicionar("acao")
        novo["ultima_acao_ms"], novo["ultimo_estado"] = agora_ms, nome
    if (novo["ultimo_heartbeat_ms"] is None
            or agora_ms - novo["ultimo_heartbeat_ms"] >= m["heartbeat_ms"]):
        adicionar("heartbeat")
        novo["ultimo_heartbeat_ms"] = agora_ms
    return novo, mensagens
