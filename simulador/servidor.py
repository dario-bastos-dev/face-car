"""Servidor local da Parte 3: página do simulador, modelo de imagens (CNN) e estimador em Python.

    python simulador/servidor.py                       # http://localhost:8000/simulador/
    python simulador/servidor.py --metricas saidas/webcam.csv --sem-repetir

- HTTP (porta 8000): serve a raiz do repositório, para a página ler config/, contratos/,
  demo-navegador/ e modelos/. Sem cache, para o desenvolvimento. `simulador/servidor.json`
  informa à página a porta do WebSocket.
- WebSocket (porta 8765, requer `pip install websockets`):
  - `/cnn`: o modelo de imagens da Parte 1 (cnn_sonolencia.keras, config/analise.json). A
    página manda cada quadro da câmera já reduzido ao tamanho de entrada do modelo (RGB,
    sem desenho) e recebe a classe, as probabilidades e a média da janela. Os quadros só
    existem na memória: nada é gravado.
  - qualquer outro caminho: roda o estimador da Parte 2 em tempo real sobre um CSV de
    métricas (contrato metricas.v1), com ticks de 100 ms, e envia ações e heartbeats no
    contrato sinal.v1. A página responde com `status_entrega` de cada mensagem e
    `resposta_motorista` ("Estou atento"), que vira `resposta_motorista=True` no próximo tick.
- Registro (sem vídeo): mensagens do estimador em saidas/simulador-<sessao>.jsonl.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from entrada.contrato import ler_metricas  # noqa: E402
from estimador import carregar_config, estimar  # noqa: E402
from estimador.mensagens import emitir, estado_emissor_inicial  # noqa: E402
from estimador.politica import estado_inicial, transicionar  # noqa: E402

PASSO_MS = 100
PORTA_WS = 8765  # trocada pela linha de comando; a página lê em simulador/servidor.json
sys.stdout.reconfigure(line_buffering=True)  # registro aparece na hora, mesmo redirecionado


class SemCache(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/simulador/servidor.json":
            corpo = json.dumps({"ws": PORTA_WS}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):  # silencioso: o registro relevante é o do WebSocket
        pass


def servir_http(porta: int) -> None:
    servidor = ThreadingHTTPServer(("127.0.0.1", porta), partial(SemCache, directory=str(RAIZ)))
    servidor.serve_forever()


def linha_do_tempo(metricas: list[dict], repetir: bool):
    """Métricas em ordem, com t_ms deslocado a cada volta quando repetir=True."""
    if not metricas:
        return
    inicio, fim = metricas[0]["t_ms"], metricas[-1]["t_ms"]
    duracao = fim - inicio + PASSO_MS
    volta = 0
    while True:
        for m in metricas:
            yield {**m, "t_ms": m["t_ms"] - inicio + volta * duracao}
        if not repetir:
            return
        volta += 1


async def sessao_estimador(conexao, metricas: list[dict], config: dict, repetir: bool) -> None:
    sessao = f"python-{int(time.time())}"
    registro = (RAIZ / "saidas" / f"simulador-{sessao}.jsonl")
    registro.parent.mkdir(exist_ok=True)
    print(f"[WS] Página conectada · sessão {sessao}")
    estado, emissor = estado_inicial(), estado_emissor_inicial(sessao)
    fila, janela, respondeu = linha_do_tempo(metricas, repetir), [], False
    proxima = next(fila, None)
    retencao = config["janela_s"] * 1000 + config["min_fechamento_ms"] + config["max_intervalo_ms"]
    t0 = time.monotonic()

    with registro.open("a", encoding="utf-8") as log:
        def anotar(direcao, obj):
            log.write(json.dumps({"direcao": direcao, "t_local_ms": int((time.monotonic() - t0) * 1000), **obj}, ensure_ascii=False) + "\n")

        async def ler():
            nonlocal respondeu
            async for texto in conexao:
                try:
                    obj = json.loads(texto)
                except json.JSONDecodeError:
                    continue
                anotar("recebida", obj)
                if obj.get("tipo") == "resposta_motorista":
                    respondeu = True
                    print("[WS] Resposta do motorista recebida")
                elif obj.get("tipo") == "status_entrega" and obj.get("status") != "aceita":
                    print(f"[WS] Página recusou seq {obj.get('seq')}: {obj.get('status')}")

        leitor = asyncio.create_task(ler())
        try:
            while True:
                agora = int((time.monotonic() - t0) * 1000)
                while proxima is not None and proxima["t_ms"] <= agora:
                    janela.append(proxima)
                    proxima = next(fila, None)
                while janela and janela[0]["t_ms"] < agora - retencao:
                    janela.pop(0)
                estimativa = estimar(janela, config, agora)
                estado = transicionar(estado, estimativa, agora, config, respondeu)
                respondeu = False
                emissor, mensagens = emitir(emissor, estado, estimativa, agora, config)
                for m in mensagens:
                    anotar("enviada", m)
                    await conexao.send(json.dumps(m, ensure_ascii=False))
                    if m["tipo"] == "acao":
                        print(f"[WS] seq {m['seq']:>5} · {m['estado']:<11} índice {m['indice']}")
                await asyncio.sleep(max(0, (agora + PASSO_MS) / 1000 - (time.monotonic() - t0)))
        except Exception as erro:  # conexão fechada pela página
            print(f"[WS] Sessão {sessao} encerrada ({type(erro).__name__})")
        finally:
            leitor.cancel()


# ---- modelo de imagens (CNN) ----------------------------------------------------

class ServicoCnn:
    """Carrega o modelo da Parte 1 em segundo plano e classifica os quadros da página.

    Usa o classificador e a média temporal da análise em tempo real (entrada/classificador.py),
    com classes e janela de config/analise.json. A página manda o quadro inteiro já
    redimensionado para o tamanho de entrada do modelo, em RGB: é o que `preparar` produz a
    partir de um quadro BGR, então o modelo recebe a mesma imagem que na análise.
    """

    def __init__(self, config: dict, caminho: Path, carregar=None):
        self.config, self.caminho = config, caminho
        self.classificador, self.erro, self.pronto = None, None, threading.Event()
        # um só fio para o modelo: as previsões não rodam em paralelo
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cnn")
        self._carregador = carregar
        self.executor.submit(self._carregar, carregar)

    def tentar_de_novo(self) -> None:
        """Sem modelo carregado, tenta outra vez: o arquivo pode ter sido copiado depois."""
        if self.classificador is None and self.pronto.is_set():
            self.pronto.clear()
            self.erro = None
            self.executor.submit(self._carregar, self._carregador)

    def _carregar(self, carregar) -> None:
        try:
            os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
            from entrada.classificador import ClassificadorSonolencia

            if carregar is None:
                if not self.caminho.is_file():
                    raise FileNotFoundError(f"modelo não encontrado: {self.caminho.name} (o .keras "
                                            "fica fora do git; coloque-o na raiz do projeto)")
                print(f"[CNN] Carregando {self.caminho.name}...")
                carregar = ClassificadorSonolencia.carregar
            self.classificador = carregar(self.caminho, self.config["classificador"]["classes"])
            print(f"[CNN] Pronto: entrada {self.classificador.tamanho}x{self.classificador.tamanho}, "
                  f"classes {', '.join(self.classificador.classes)}")
        except Exception as erro:  # sem modelo ou sem TensorFlow: a página segue sem o CNN
            self.erro = f"{type(erro).__name__}: {erro}"
            print(f"[CNN] Indisponível: {self.erro}")
        finally:
            self.pronto.set()

    def classificar(self, rgb):
        """Resultado do modelo para um quadro RGB (tamanho x tamanho x 3, uint8)."""
        import numpy as np
        from entrada.classificador import Resultado

        modelo = self.classificador
        inicio = time.perf_counter()
        saida = modelo.modelo.predict_on_batch(rgb[np.newaxis].astype(np.float32))
        ms = (time.perf_counter() - inicio) * 1000
        p = np.asarray(saida, dtype=float)[0]
        return Resultado(modelo.classes[int(np.argmax(p))], dict(zip(modelo.classes, p.tolist())),
                         p.tolist(), ms)


def decodificar_quadro(dados: bytes, tamanho: int):
    """(t_ms, quadro RGB) de uma mensagem binária: float64 little-endian seguido dos pixels RGB."""
    import numpy as np

    esperado = 8 + tamanho * tamanho * 3
    if len(dados) != esperado:
        raise ValueError(f"quadro com {len(dados)} bytes; esperado {esperado}")
    (t_ms,) = struct.unpack_from("<d", dados)
    return t_ms, np.frombuffer(dados, np.uint8, offset=8).reshape(tamanho, tamanho, 3)


async def sessao_cnn(conexao, servico: ServicoCnn) -> None:
    from entrada.classificador import MediaTemporal

    loop = asyncio.get_running_loop()
    servico.tentar_de_novo()
    await loop.run_in_executor(None, servico.pronto.wait)
    if servico.classificador is None:
        await conexao.send(json.dumps({"tipo": "cnn_indisponivel", "motivo": servico.erro}, ensure_ascii=False))
        await conexao.close()
        return
    modelo, cfg = servico.classificador, servico.config["classificador"]
    await conexao.send(json.dumps({"tipo": "cnn_pronto", "tamanho": modelo.tamanho, "classes": modelo.classes,
                                   "janela_ms": cfg["janela_ms"]}))
    print("[CNN] Página conectada")
    media = MediaTemporal(cfg["janela_ms"])
    try:
        async for dados in conexao:
            if not isinstance(dados, bytes):
                continue
            t_ms, rgb = decodificar_quadro(dados, modelo.tamanho)
            r = await loop.run_in_executor(servico.executor, servico.classificar, rgb)
            media.adicionar(t_ms, r)
            resumo, qps = media.resumo()
            await conexao.send(json.dumps({
                "tipo": "cnn", "t_ms": t_ms, "classe": r.classe, "probabilidades": r.probabilidades,
                "ms": round(r.ms, 1), "qps": round(qps, 1),
                "media": {"classe": resumo.classe, "probabilidades": resumo.probabilidades}}))
    except Exception as erro:  # conexão fechada pela página
        print(f"[CNN] Página desconectada ({type(erro).__name__})")


async def roteador(conexao, servico: ServicoCnn, **estimador) -> None:
    """`/cnn` vai para o modelo de imagens; o resto, para o estimador da Parte 2."""
    if conexao.request.path.split("?")[0].rstrip("/") == "/cnn":
        await sessao_cnn(conexao, servico)
    else:
        await sessao_estimador(conexao, **estimador)


async def principal(args) -> None:
    global PORTA_WS
    PORTA_WS = args.porta_ws
    threading.Thread(target=servir_http, args=(args.porta,), daemon=True).start()
    print(f"\n=== VIGIA · Parte 3 ===\nSimulador: http://localhost:{args.porta}/simulador/")
    print("A câmera exige permissão do navegador; nenhum quadro é gravado. Ctrl+C encerra.\n")
    try:
        from websockets.asyncio.server import serve
    except ImportError:
        print("[Aviso] Pacote websockets ausente: só o HTTP está ativo. Para o estimador em Python:")
        print("        pip install websockets   (ou: uv pip install websockets)\n")
        await asyncio.Future()
        return
    from entrada.contexto import carregar_config as carregar_config_analise

    analise = carregar_config_analise()
    servico = ServicoCnn(analise, args.modelo or RAIZ / analise["classificador"]["modelo"])
    config = carregar_config()
    metricas = [asdict(m) for m in ler_metricas(args.metricas)]
    print(f"Modelo de imagens (CNN): ws://localhost:{args.porta_ws}/cnn · usado pelo scanner da página")
    print(f"Estimador em Python: ws://localhost:{args.porta_ws} · {len(metricas)} métricas de {args.metricas}")
    print(f"Para comandar o simulador por ele: http://localhost:{args.porta}/simulador/?ws=ws://localhost:{args.porta_ws}")
    async with serve(partial(roteador, servico=servico, metricas=metricas, config=config,
                             repetir=not args.sem_repetir),
                     "127.0.0.1", args.porta_ws, max_size=2 ** 20):
        await asyncio.Future()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Servidor local do simulador (Parte 3)")
    p.add_argument("--porta", type=int, default=8000)
    p.add_argument("--porta-ws", type=int, default=8765)
    p.add_argument("--metricas", type=Path, default=RAIZ / "contratos" / "metricas.exemplo.csv",
                   help="CSV no contrato metricas.v1 (por exemplo, gravado pelo extrator ou pelo scanner)")
    p.add_argument("--sem-repetir", action="store_true", help="não reinicia o CSV ao chegar ao fim")
    p.add_argument("--modelo", type=Path,
                   help="modelo de imagens .keras (padrão: classificador.modelo em config/analise.json)")
    try:
        asyncio.run(principal(p.parse_args()))
    except KeyboardInterrupt:
        print("\nServidor encerrado")
