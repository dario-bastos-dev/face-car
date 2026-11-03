"""Orquestração sem câmera, com ticks independentes da chegada de métricas."""

from collections import deque

from .nucleo import estimar, validar_sequencia, validar_tempo
from .politica import estado_inicial, transicionar
from .mensagens import estado_emissor_inicial, emitir


def reproduzir(metricas, config, *, passo_ms=100, cauda_ms=1000,
               respostas=(), sessao="replay"):
    """Produz registros de estimativa, política e mensagens em relógio virtual.

    cauda_ms mantém o relógio ativo após a última métrica para demonstrar
    degradação e heartbeat. Nenhuma espera de tempo real ou acesso à câmera.
    Respostas são eventos em ms relativos ao mesmo início da captura.
    """
    metricas = list(metricas)
    validar_sequencia(metricas)
    validar_tempo(passo_ms, "passo_ms")
    validar_tempo(cauda_ms, "cauda_ms")
    if not 0 < passo_ms <= min(config["politica"]["intervalo_maximo_ms"],
                               config["mensagens"]["heartbeat_ms"]):
        raise ValueError("passo_ms deve ser positivo e respeitar política e heartbeat")
    respostas = list(respostas)
    for t in respostas:
        validar_tempo(t, "resposta")
    if respostas != sorted(set(respostas)):
        raise ValueError("Respostas devem estar em ordem estritamente crescente")
    inicio = metricas[0]["t_ms"] if metricas else 0
    fim = (metricas[-1]["t_ms"] if metricas else 0) + cauda_ms
    validar_tempo(fim, "fim")
    if any(t < inicio or t > fim for t in respostas):
        raise ValueError("Resposta fora do intervalo do replay")
    estado, emissor = estado_inicial(), estado_emissor_inicial(sessao)
    buffer = deque()
    i = r = 0
    retencao = (config["janela_s"] * 1000 + config["min_fechamento_ms"]
                + config["max_intervalo_ms"])
    # Inclui o instante final mesmo se o passo não dividir a duração.
    ticks = range(int(inicio), int(fim) + 1, int(passo_ms))
    from itertools import chain
    ticks = chain(ticks, [fim] if (fim - inicio) % passo_ms else [])
    for agora in ticks:
        while i < len(metricas) and metricas[i]["t_ms"] <= agora:
            buffer.append(metricas[i])
            i += 1
        while len(buffer) > 1 and buffer[1]["t_ms"] < agora - retencao:
            buffer.popleft()
        respondeu = False
        while r < len(respostas) and respostas[r] <= agora:
            respondeu = True
            r += 1
        estimativa = estimar(buffer, config, agora)
        estado = transicionar(estado, estimativa, agora, config, respondeu)
        emissor, mensagens = emitir(emissor, estado, estimativa, agora, config)
        yield {"estimativa": estimativa, "estado": estado, "mensagens": mensagens}
