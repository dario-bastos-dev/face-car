"""Servidor local da Parte 3: página do simulador + estimador em Python por WebSocket.

    python simulador/servidor.py                       # http://localhost:8000/simulador/
    python simulador/servidor.py --metricas saidas/webcam.csv --sem-repetir

- HTTP (porta 8000): serve a raiz do repositório, para a página ler config/, contratos/,
  demo-navegador/ e modelos/. Sem cache, para o desenvolvimento.
- WebSocket (porta 8765, opcional, requer `pip install websockets`): a cada conexão roda o
  estimador da Parte 2 em tempo real sobre um CSV de métricas (contrato metricas.v1), com
  ticks de 100 ms, e envia ações e heartbeats no contrato sinal.v1. A página responde com
  `status_entrega` de cada mensagem e `resposta_motorista` ("Estou atento"), que vira
  `resposta_motorista=True` no próximo tick da política.
- Registro (sem vídeo): mensagens enviadas e recebidas em saidas/simulador-<sessao>.jsonl.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import threading
import time
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
sys.stdout.reconfigure(line_buffering=True)  # registro aparece na hora, mesmo redirecionado


class SemCache(SimpleHTTPRequestHandler):
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


async def principal(args) -> None:
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
    config = carregar_config()
    metricas = [asdict(m) for m in ler_metricas(args.metricas)]
    print(f"Estimador em Python: ws://localhost:{args.porta_ws} · {len(metricas)} métricas de {args.metricas}")
    async with serve(partial(sessao_estimador, metricas=metricas, config=config, repetir=not args.sem_repetir),
                     "127.0.0.1", args.porta_ws):
        await asyncio.Future()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Servidor local do simulador (Parte 3)")
    p.add_argument("--porta", type=int, default=8000)
    p.add_argument("--porta-ws", type=int, default=8765)
    p.add_argument("--metricas", type=Path, default=RAIZ / "exemplos" / "parte2" / "metricas.csv",
                   help="CSV no contrato metricas.v1 (por exemplo, gravado pelo extrator ou pelo scanner)")
    p.add_argument("--sem-repetir", action="store_true", help="não reinicia o CSV ao chegar ao fim")
    try:
        asyncio.run(principal(p.parse_args()))
    except KeyboardInterrupt:
        print("\nServidor encerrado")
