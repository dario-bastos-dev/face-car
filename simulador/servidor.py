"""Servidor local da Parte 3: página do simulador, modelo de imagens (CNN) e estimador em Python.

    python simulador/servidor.py                       # http://localhost:8000/simulador/
    python simulador/servidor.py --metricas saidas/webcam.csv --sem-repetir

- HTTP (porta 8000): serve a raiz do repositório, para a página ler config/, contratos/,
  demo-navegador/ e modelos/. Sem cache, para o desenvolvimento. `simulador/servidor.json`
  informa à página a porta do WebSocket.
- WebSocket (porta 8765, requer `pip install websockets`):
  - `/cnn`: o modelo de imagens CNN V2 configurado em config/analise.json. A
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
import hashlib
import json
import math
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


def criar_cascade(cv2, caminho: Path):
    """Detector Haar do recorte da V3. No OpenCV 5 o CascadeClassifier saiu do pacote básico
    (opencv-python) e ficou no opencv-contrib-python, que é o que o projeto declara (uv.lock)."""
    for mod in (cv2, getattr(cv2, "objdetect", None), getattr(cv2, "xobjdetect", None)):
        classe = getattr(mod, "CascadeClassifier", None) if mod is not None else None
        if classe is not None:
            return classe(str(caminho))
    raise RuntimeError(
        f"o OpenCV {getattr(cv2, '__version__', '?')} instalado não tem o detector Haar (CascadeClassifier); "
        'instale o do projeto (uv sync) ou: pip uninstall -y opencv-python && pip install opencv-contrib-python==5.0.0.93')


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

    def __init__(self, config: dict, caminho: Path, carregar=None, diagnostico: bool = False):
        self.config, self.caminho = config, caminho
        self.diagnostico = diagnostico
        self.model_meta = None
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
            caminho_abs = self.caminho.resolve()
            sha256 = hashlib.sha256(caminho_abs.read_bytes()).hexdigest().upper() if caminho_abs.is_file() else None
            self.model_meta = {
                "caminho": str(caminho_abs), "sha256": sha256,
                "entrada": list(self.classificador.modelo.input_shape),
                "saidas": int(self.classificador.modelo.output_shape[-1]),
                "classes": list(self.classificador.classes),
                "sha256_esperado": "C87F4D6E362C399B15D1960CE841290C11F006C5CABCDE856CA088F18CAC00C6",
                "modelo_correto": sha256 == "C87F4D6E362C399B15D1960CE841290C11F006C5CABCDE856CA088F18CAC00C6",
            }
            print("[CNN_META] " + json.dumps(self.model_meta, ensure_ascii=False))
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

        from entrada.classificador import _conferir_probabilidades

        modelo = self.classificador
        inicio = time.perf_counter()
        saida = modelo.modelo.predict_on_batch(rgb[np.newaxis].astype(np.float32))
        ms = (time.perf_counter() - inicio) * 1000
        p = np.asarray(saida, dtype=float)[0]
        _conferir_probabilidades(p)   # valores de 0 a 1 que somam 1, como na análise em Python
        return Resultado(modelo.classes[int(np.argmax(p))], dict(zip(modelo.classes, p.tolist())),
                         p.tolist(), ms)


class ServicoOlhosV3:
    """Classificador auxiliar de olhos; nunca alimenta o estimador ou a política."""

    def __init__(self, caminho: Path):
        self.caminho = Path(caminho)
        self.modelo, self.erro = None, None
        self.detector_rosto = None
        self.pronto = threading.Event()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cnn-olhos")
        self.executor.submit(self._carregar)

    def tentar_de_novo(self) -> None:
        if self.modelo is None and self.pronto.is_set():
            self.pronto.clear()
            self.erro = None
            self.executor.submit(self._carregar)

    def _carregar(self) -> None:
        try:
            import cv2
            import numpy as np

            if not self.caminho.is_file():
                raise FileNotFoundError(f"modelo de olhos não encontrado: {self.caminho}")
            caminho_cascade = Path(__file__).with_name("haarcascade_frontalface_default.xml")
            if not caminho_cascade.is_file():
                raise FileNotFoundError(f"cascade facial não encontrado: {caminho_cascade}")
            detector_rosto = criar_cascade(cv2, caminho_cascade)
            if detector_rosto.empty():
                raise RuntimeError(f"cascade facial inválido: {caminho_cascade}")
            import keras

            print(f"[OLHOS_V3] Carregando {self.caminho}...")
            modelo = keras.models.load_model(self.caminho, compile=False)
            if tuple(modelo.input_shape[1:]) != (160, 160, 3):
                raise ValueError(f"entrada inesperada: {modelo.input_shape}")
            if int(modelo.output_shape[-1]) != 1:
                raise ValueError(f"saída binária inesperada: {modelo.output_shape}")
            aquecimento = modelo.predict_on_batch(np.zeros((1, 160, 160, 3), dtype=np.float32))
            if len(aquecimento[0]) != 1 or not 0 <= float(aquecimento[0][0]) <= 1:
                raise ValueError("a saída da CNN de olhos não é uma probabilidade sigmoid")
            self.modelo = modelo
            self.detector_rosto = detector_rosto
            caminho_abs = self.caminho.resolve()
            meta = {
                "caminho": str(caminho_abs),
                "entrada": list(modelo.input_shape),
                "saidas": 1,
                "classe_positiva": "olhos_fechados",
                "normalizacao_interna": True,
                "detector_recorte": "opencv_haar_frontalface_default",
                "margem_recorte": 0.08,
            }
            print("[OLHOS_V3_META] " + json.dumps(meta, ensure_ascii=False))
            print("[OLHOS_V3] Pronto para observação")
        except Exception as erro:
            self.erro = f"{type(erro).__name__}: {erro}"
            print(f"[OLHOS_V3] Indisponível; V2 continua ativa: {self.erro}")
        finally:
            self.pronto.set()

    def classificar(self, rgb):
        """Recebe RGB uint8 0..255; a normalização fica na camada interna do modelo."""
        import numpy as np

        if self.modelo is None:
            raise RuntimeError(self.erro or "CNN de olhos ainda não está disponível")
        imagem = np.asarray(rgb)
        if imagem.shape != (160, 160, 3):
            raise ValueError(f"recorte de olhos inválido: {imagem.shape}; esperado (160, 160, 3)")
        if not np.issubdtype(imagem.dtype, np.number) or not np.isfinite(imagem).all():
            raise ValueError("recorte de olhos deve conter pixels RGB numéricos")
        if np.any(imagem < 0) or np.any(imagem > 255):
            raise ValueError("pixels RGB fora da faixa 0..255")
        inicio = time.perf_counter()
        p = np.asarray(self.modelo.predict_on_batch(imagem[np.newaxis].astype(np.float32)),
                       dtype=float).reshape(-1)
        ms = (time.perf_counter() - inicio) * 1000
        if p.size != 1 or not np.isfinite(p[0]) or not 0 <= p[0] <= 1:
            raise ValueError(f"probabilidade inválida da CNN de olhos: {p.tolist()}")
        return {
            "probabilidade_olhos_fechados": float(p[0]),
            "olhos_fechados": bool(p[0] >= 0.5),
            "limiar": 0.5,
            "inferencia_ms": round(ms, 2),
        }

    def falha_inferencia(self, erro: Exception) -> None:
        self.erro = f"{type(erro).__name__}: {erro}"
        self.modelo = None
        print(f"[OLHOS_V3] Inferência interrompida; V2 continua ativa: {self.erro}")


def decodificar_quadro(dados: bytes, tamanho: int):
    """(t_ms, quadro RGB) de uma mensagem binária: float64 little-endian seguido dos pixels RGB."""
    import numpy as np

    esperado = 8 + tamanho * tamanho * 3
    if len(dados) != esperado:
        raise ValueError(f"quadro com {len(dados)} bytes; esperado {esperado}")
    (t_ms,) = struct.unpack_from("<d", dados)
    return t_ms, np.frombuffer(dados, np.uint8, offset=8).reshape(tamanho, tamanho, 3)


def decodificar_quadro_bruto(dados: bytes, largura: int, altura: int):
    """Decodifica um quadro RGB original enviado pelo modo rosto."""
    import numpy as np

    esperado = largura * altura * 3
    if len(dados) != esperado:
        raise ValueError(f"quadro bruto com {len(dados)} bytes; esperado {esperado}")
    return np.frombuffer(dados, np.uint8).reshape(altura, largura, 3)


def preparar_rosto(rgb, caixa: dict | None, tamanho: int):
    """Reproduz camera_v2.py: margem de 20%, proporção e padding preto."""
    import cv2
    import numpy as np

    if not caixa:
        return None
    altura, largura = rgb.shape[:2]
    x1 = int(caixa["xmin"] * largura)
    y1 = int(caixa["ymin"] * altura)
    x2 = int((caixa["xmin"] + caixa["width"]) * largura)
    y2 = int((caixa["ymin"] + caixa["height"]) * altura)
    margem_x = int((x2 - x1) * 0.20)
    margem_y = int((y2 - y1) * 0.20)
    x1, y1 = max(0, x1 - margem_x), max(0, y1 - margem_y)
    x2, y2 = min(largura, x2 + margem_x), min(altura, y2 + margem_y)
    rosto = rgb[y1:y2, x1:x2]
    if rosto.size == 0:
        return None
    h, w = rosto.shape[:2]
    escala = min(tamanho / w, tamanho / h)
    novo_w, novo_h = max(1, round(w * escala)), max(1, round(h * escala))
    rosto = cv2.resize(rosto, (novo_w, novo_h), interpolation=cv2.INTER_LINEAR)
    imagem = np.zeros((tamanho, tamanho, 3), dtype=np.uint8)
    topo, esquerda = (tamanho - novo_h) // 2, (tamanho - novo_w) // 2
    imagem[topo:topo + novo_h, esquerda:esquerda + novo_w] = rosto
    return imagem


def preparar_rosto_olhos(rgb, detector, tamanho: int = 160):
    """Reproduz o recorte Haar de 8% usado no treino da V3."""
    import cv2

    altura, largura = rgb.shape[:2]
    cinza = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    faces = detector.detectMultiScale(
        cinza, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
    if not len(faces):
        return None
    x1, y1, largura_rosto, altura_rosto = max(faces, key=lambda face: face[2] * face[3])
    x2, y2 = x1 + largura_rosto, y1 + altura_rosto
    margem_x = int(largura_rosto * 0.08)
    margem_y = int(altura_rosto * 0.08)
    x1, y1 = max(0, x1 - margem_x), max(0, y1 - margem_y)
    x2, y2 = min(largura, x2 + margem_x), min(altura, y2 + margem_y)
    rosto = rgb[y1:y2, x1:x2]
    if rosto.size == 0:
        return None
    return cv2.resize(rosto, (tamanho, tamanho), interpolation=cv2.INTER_AREA)


async def sessao_cnn(conexao, servico: ServicoCnn, servico_olhos: ServicoOlhosV3 | None = None) -> None:
    from entrada.classificador import MediaTemporal

    loop = asyncio.get_running_loop()
    servico.tentar_de_novo()
    if servico_olhos:
        servico_olhos.tentar_de_novo()
    await loop.run_in_executor(None, servico.pronto.wait)
    if servico.classificador is None:
        await conexao.send(json.dumps({"tipo": "cnn_indisponivel", "motivo": servico.erro}, ensure_ascii=False))
        await conexao.close()
        return
    modelo, cfg = servico.classificador, servico.config["classificador"]
    await conexao.send(json.dumps({"tipo": "cnn_pronto", "tamanho": modelo.tamanho, "classes": modelo.classes,
                                   "janela_ms": cfg["janela_ms"], "modelo": servico.model_meta}))
    print("[CNN] Página conectada")
    media = MediaTemporal(cfg["janela_ms"])
    quadro_bruto = None
    try:
        async for dados in conexao:
            if isinstance(dados, str):
                try:
                    meta = json.loads(dados)
                except json.JSONDecodeError:
                    continue
                if meta.get("tipo") == "cnn_quadro":
                    quadro_bruto = meta
                continue
            if not isinstance(dados, bytes):
                continue
            recebido_em = time.monotonic()
            meta = None
            rgb_original = None
            ear_mediapipe = None
            if quadro_bruto is not None:
                meta, quadro_bruto = quadro_bruto, None
                rgb_original = decodificar_quadro_bruto(dados, int(meta["largura"]), int(meta["altura"]))
                rgb = preparar_rosto(rgb_original, meta.get("caixa"), modelo.tamanho)
                if rgb is None:
                    continue
                ear = meta.get("ear")
                if isinstance(ear, (int, float)) and math.isfinite(float(ear)):
                    ear_mediapipe = float(ear)
                t_ms, modo = float(meta["t_ms"]), "rosto"
            else:
                t_ms, rgb, modo = (*decodificar_quadro(dados, modelo.tamanho), "inteiro")
            r = await loop.run_in_executor(servico.executor, servico.classificar, rgb)
            media.adicionar(t_ms, r)
            resumo, qps = media.resumo()
            resultado_olhos = None
            estado_olhos = "nao_configurado" if servico_olhos is None else "carregando"
            if servico_olhos is not None:
                if servico_olhos.modelo is None:
                    estado_olhos = "indisponivel" if servico_olhos.pronto.is_set() else "carregando"
                elif rgb_original is None:
                    estado_olhos = "sem_recorte_facial"
                else:
                    try:
                        rgb_olhos = preparar_rosto_olhos(
                            rgb_original, servico_olhos.detector_rosto)
                        if rgb_olhos is None:
                            estado_olhos = "sem_recorte_facial"
                        else:
                            resultado_olhos = await loop.run_in_executor(
                                servico_olhos.executor, servico_olhos.classificar, rgb_olhos)
                            estado_olhos = "observado"
                    except Exception as erro:
                        servico_olhos.falha_inferencia(erro)
                        estado_olhos = "erro"
            if servico.diagnostico:
                print("[CNN_DIAG] " + json.dumps({
                    "conexao_ativa": True,
                    "modelo_correto": bool(servico.model_meta and servico.model_meta["modelo_correto"]),
                    "probabilidades_instantaneas": r.probabilidades,
                    "probabilidades_media": resumo.probabilidades,
                    "v2": {
                        "probabilidades_instantaneas": r.probabilidades,
                        "probabilidades_media": resumo.probabilidades,
                    },
                    "v3_olhos": {
                        "estado": estado_olhos,
                        "probabilidade_olhos_fechados": (
                            resultado_olhos["probabilidade_olhos_fechados"] if resultado_olhos else None),
                        "olhos_fechados": resultado_olhos["olhos_fechados"] if resultado_olhos else None,
                        "limiar": resultado_olhos["limiar"] if resultado_olhos else 0.5,
                        "inferencia_ms": resultado_olhos["inferencia_ms"] if resultado_olhos else None,
                        "preprocessamento": (
                            "haar_frontalface_8pct_rgb160" if resultado_olhos else None),
                    },
                    "ear_mediapipe": ear_mediapipe,
                    "classe_instantanea": r.classe, "classe_media": resumo.classe,
                    "preprocessamento": modo,
                    "inferencia_ms": round(r.ms, 2), "qps": round(qps, 2),
                    "idade_ultima_previsao_ms": round((time.monotonic() - recebido_em) * 1000, 2),
                }, ensure_ascii=False))
            await conexao.send(json.dumps({
                "tipo": "cnn", "t_ms": t_ms, "classe": r.classe, "probabilidades": r.probabilidades,
                "preprocessamento": modo,
                "ms": round(r.ms, 1), "qps": round(qps, 1),
                "media": {"classe": resumo.classe, "probabilidades": resumo.probabilidades}}))
    except Exception as erro:  # conexão fechada pela página
        print(f"[CNN] Página desconectada ({type(erro).__name__})")


async def roteador(conexao, servico: ServicoCnn, servico_olhos: ServicoOlhosV3 | None = None,
                   **estimador) -> None:
    """`/cnn` vai para o modelo de imagens; o resto, para o estimador da Parte 2."""
    if conexao.request.path.split("?")[0].rstrip("/") == "/cnn":
        await sessao_cnn(conexao, servico, servico_olhos)
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
    servico = ServicoCnn(analise, args.modelo or Path(analise["classificador"]["modelo"]),
                         diagnostico=args.diagnostico_cnn)
    servico_olhos = ServicoOlhosV3(args.modelo_olhos or RAIZ / "cnn_olhos_v3.keras")
    config = carregar_config()
    metricas = [asdict(m) for m in ler_metricas(args.metricas)]
    print(f"Modelo de imagens (CNN): ws://localhost:{args.porta_ws}/cnn · usado pelo scanner da página")
    print(f"CNN de olhos V3: observação independente · {servico_olhos.caminho}")
    print(f"Estimador em Python: ws://localhost:{args.porta_ws} · {len(metricas)} métricas de {args.metricas}")
    print(f"Para comandar o simulador por ele: http://localhost:{args.porta}/simulador/?ws=ws://localhost:{args.porta_ws}")
    async with serve(partial(roteador, servico=servico, servico_olhos=servico_olhos,
                             metricas=metricas, config=config,
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
    p.add_argument("--modelo-olhos", type=Path,
                   help="modelo experimental de olhos .keras (padrão: cnn_olhos_v3.keras na raiz)")
    p.add_argument("--diagnostico-cnn", action="store_true",
                   help="registra probabilidades V2, V3 de olhos, EAR e latência no terminal")
    try:
        asyncio.run(principal(p.parse_args()))
    except KeyboardInterrupt:
        print("\nServidor encerrado")
