"""Máquina de estados pura, orientada pela tabela de config/estimador.json.

Chamadas devem usar um relógio monotônico da sessão, mesmo sem novos quadros.
O reconhecimento do motorista renova o prazo em ALERTA, sem diminuir o risco.
"""

from copy import deepcopy
from .config import numero

ESTADOS = ("NORMAL", "ATENCAO", "ALERTA", "INTERVENCAO", "DEGRADADO")
MAX_INTEIRO = 2**53 - 1


def validar_tempo(valor, nome="agora_ms"):
    if not numero(valor) or not 0 <= valor <= MAX_INTEIRO or int(valor) != valor:
        raise ValueError(f"{nome} deve ser inteiro não negativo seguro para JavaScript")


def validar_politica(config: dict) -> dict:
    p = config.get("politica")
    if not isinstance(p, dict):
        raise ValueError("Configuração politica ausente")
    conf = p.get("confianca_minima")
    if not numero(conf) or not 0 < conf <= 1:
        raise ValueError("confianca_minima deve estar em (0, 1]")
    for chave in ("validade_estimativa_ms", "intervalo_maximo_ms", "prazo_resposta_ms"):
        validar_tempo(p.get(chave), chave)
        if chave != "validade_estimativa_ms" and p[chave] == 0:
            raise ValueError(f"{chave} deve ser positivo")
    linhas = p.get("transicoes")
    if not isinstance(linhas, list) or not linhas:
        raise ValueError("Tabela de transições vazia")
    primeira = linhas[0]
    if not isinstance(primeira, dict) or any(primeira.get(k) != v for k, v in {
            "de": "*", "para": "DEGRADADO", "condicao": "sem_confianca", "duracao_ms": 0}.items()):
        raise ValueError("Primeira transição deve degradar imediatamente sem confiança")
    for n, linha in enumerate(linhas):
        if not isinstance(linha, dict):
            raise ValueError("Transição deve ser objeto")
        validar_tempo(linha.get("duracao_ms"), "duracao_ms")
        if n == 0:
            continue
        if (linha.get("de") not in ESTADOS or linha.get("para") not in ESTADOS
                or linha["de"] == linha["para"]):
            raise ValueError("Estados da transição inválidos")
        condicao = linha.get("condicao")
        if condicao not in ("alto", "baixo", "recuperado", "sem_resposta"):
            raise ValueError("Condição da transição inválida")
        if condicao == "recuperado" and linha["de"] != "DEGRADADO":
            raise ValueError("recuperado só pode sair de DEGRADADO")
        if ((condicao == "sem_resposta" and (linha["de"], linha["para"]) != ("ALERTA", "INTERVENCAO"))
                or (linha["para"] == "INTERVENCAO" and condicao != "sem_resposta")):
            raise ValueError("INTERVENCAO exige ALERTA, evidência e prazo sem resposta")
        limiar = linha.get("limiar")
        if not numero(limiar) or not 0 <= limiar <= 100:
            raise ValueError("limiar deve estar em [0, 100]")
    return config


def estado_inicial() -> dict:
    return {"nome": "DEGRADADO", "inicio_ms": None, "ultimo_ms": None,
            "pendente": None, "pendente_desde_ms": None,
            "prazo_resposta_em_ms": None}


def evidencia_valida(estimativa: dict, agora_ms: int, config: dict) -> bool:
    p = config["politica"]
    indice, confianca, instante = (estimativa.get(k) for k in ("indice", "confianca", "t_ms"))
    return (numero(indice) and 0 <= indice <= 100
            and numero(confianca) and p["confianca_minima"] <= confianca <= 1
            and numero(instante) and int(instante) == instante
            and 0 <= instante <= agora_ms
            and agora_ms - instante <= p["validade_estimativa_ms"])


def transicionar(estado: dict, estimativa: dict, agora_ms: int, config: dict,
                 resposta_motorista: bool = False) -> dict:
    """Retorna um novo estado; não altera argumentos nem consulta relógios.

    A ordem das linhas é a prioridade. Duração mede condição contínua entre
    ticks; lacunas maiores que intervalo_maximo_ms apagam essa evidência.
    Em sem_resposta, duração e prazo são condições simultâneas: uma não soma
    atraso à outra. O próximo tick após ambos os limites efetiva a transição.
    """
    validar_politica(config)
    validar_tempo(agora_ms)
    validar_tempo(agora_ms + config["politica"]["prazo_resposta_ms"], "prazo absoluto")
    if estado.get("nome") not in ESTADOS:
        raise ValueError("Estado desconhecido")
    if not isinstance(resposta_motorista, bool):
        raise ValueError("resposta_motorista deve ser booleano")
    novo = deepcopy(estado)
    anterior_ms = novo["ultimo_ms"]
    if anterior_ms is not None and agora_ms < anterior_ms:
        raise ValueError("Tempo da política fora de ordem")
    p = config["politica"]
    if novo["inicio_ms"] is None:
        novo["inicio_ms"] = agora_ms
    if anterior_ms is not None and agora_ms - anterior_ms > p["intervalo_maximo_ms"]:
        novo["pendente"] = novo["pendente_desde_ms"] = None
        if novo["nome"] == "ALERTA":
            novo["prazo_resposta_em_ms"] = agora_ms + p["prazo_resposta_ms"]
    novo["ultimo_ms"] = agora_ms
    valido = evidencia_valida(estimativa, agora_ms, config)
    if resposta_motorista and valido and novo["nome"] == "ALERTA":
        novo["prazo_resposta_em_ms"] = agora_ms + p["prazo_resposta_ms"]
    selecionada = None
    for numero, linha in enumerate(p["transicoes"]):
        if linha["de"] not in ("*", novo["nome"]) or linha["para"] == novo["nome"]:
            continue
        condicao = linha["condicao"]
        if condicao == "sem_confianca":
            satisfeita = not valido
        elif not valido:
            satisfeita = False
        elif condicao in ("alto", "sem_resposta"):
            satisfeita = estimativa["indice"] >= linha["limiar"]
        elif condicao == "baixo":
            satisfeita = estimativa["indice"] <= linha["limiar"]
        elif condicao == "recuperado":
            satisfeita = estimativa["indice"] < linha["limiar"]
        else:
            raise ValueError(f"Condição desconhecida: {condicao}")
        if satisfeita:
            selecionada = (numero, linha)
            break
    if selecionada is None:
        novo["pendente"] = novo["pendente_desde_ms"] = None
        return novo
    numero, linha = selecionada
    if novo["pendente"] != numero:
        novo["pendente"], novo["pendente_desde_ms"] = numero, agora_ms
    prazo_cumprido = (linha["condicao"] != "sem_resposta"
                     or (novo["prazo_resposta_em_ms"] is not None
                         and agora_ms >= novo["prazo_resposta_em_ms"]))
    if agora_ms - novo["pendente_desde_ms"] >= linha["duracao_ms"] and prazo_cumprido:
        novo.update(nome=linha["para"], inicio_ms=agora_ms,
                    pendente=None, pendente_desde_ms=None,
                    prazo_resposta_em_ms=(agora_ms + p["prazo_resposta_ms"]
                                         if linha["para"] == "ALERTA" else None))
    return novo
