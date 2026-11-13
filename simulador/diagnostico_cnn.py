"""Servidor independente para diagnosticar CNN V2, CNN V3 e MediaPipe."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import time
from collections import deque
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

import cv2
import numpy as np

RAIZ = Path(__file__).resolve().parent.parent
MODELO_PADRAO = RAIZ / "cnn_sonolencia.keras"  # a CNN V2 (mesmo SHA-256 de cnn_sonolencia_v2.keras)
CLASSES = ["alerta", "sonolento", "bocejo"]
HASH_ESPERADO = "C87F4D6E362C399B15D1960CE841290C11F006C5CABCDE856CA088F18CAC00C6"
TAMANHO = 160
JANELA_MS = 2000
MODELO_OLHOS_PADRAO = RAIZ / "cnn_olhos_v3.keras"
CASCADE_PADRAO = Path(__file__).with_name("haarcascade_frontalface_default.xml")


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


class SemCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def preparar_rosto(frame_bgr: np.ndarray, caixa: dict | None) -> tuple[np.ndarray | None, list[int] | None]:
    """Reprodução de preparar_rosto de camera_v2.py."""
    if not caixa:
        return None, None
    altura, largura = frame_bgr.shape[:2]
    x1 = int(caixa["xmin"] * largura)
    y1 = int(caixa["ymin"] * altura)
    x2 = int((caixa["xmin"] + caixa["width"]) * largura)
    y2 = int((caixa["ymin"] + caixa["height"]) * altura)
    margem_x = int((x2 - x1) * 0.20)
    margem_y = int((y2 - y1) * 0.20)
    x1, y1 = max(0, x1 - margem_x), max(0, y1 - margem_y)
    x2, y2 = min(largura, x2 + margem_x), min(altura, y2 + margem_y)
    rosto = frame_bgr[y1:y2, x1:x2]
    if rosto.size == 0:
        return None, None
    rosto = cv2.cvtColor(rosto, cv2.COLOR_BGR2RGB)
    h, w = rosto.shape[:2]
    escala = min(TAMANHO / w, TAMANHO / h)
    novo_w, novo_h = max(1, round(w * escala)), max(1, round(h * escala))
    rosto = cv2.resize(rosto, (novo_w, novo_h), interpolation=cv2.INTER_LINEAR)
    imagem = np.zeros((TAMANHO, TAMANHO, 3), dtype=np.uint8)
    topo, esquerda = (TAMANHO - novo_h) // 2, (TAMANHO - novo_w) // 2
    imagem[topo:topo + novo_h, esquerda:esquerda + novo_w] = rosto
    return imagem, [x1, y1, x2, y2]


def preparar_inteiro(frame_rgb: np.ndarray) -> np.ndarray:
    return cv2.resize(frame_rgb, (TAMANHO, TAMANHO), interpolation=cv2.INTER_LINEAR)


def preparar_olhos_v3(frame_rgb: np.ndarray, detector) -> tuple[np.ndarray | None, list[int] | None]:
    """Reproduz o recorte Haar de 8% usado pela V3 no simulador."""
    altura, largura = frame_rgb.shape[:2]
    cinza = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2GRAY)
    faces = detector.detectMultiScale(
        cinza, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
    if not len(faces):
        return None, None
    x1, y1, largura_rosto, altura_rosto = max(faces, key=lambda face: face[2] * face[3])
    x2, y2 = x1 + largura_rosto, y1 + altura_rosto
    margem_x, margem_y = int(largura_rosto * 0.08), int(altura_rosto * 0.08)
    x1, y1 = max(0, x1 - margem_x), max(0, y1 - margem_y)
    x2, y2 = min(largura, x2 + margem_x), min(altura, y2 + margem_y)
    rosto = frame_rgb[y1:y2, x1:x2]
    if rosto.size == 0:
        return None, None
    caixa = [int(x1), int(y1), int(x2), int(y2)]
    return cv2.resize(rosto, (TAMANHO, TAMANHO), interpolation=cv2.INTER_AREA), caixa


class Media:
    def __init__(self):
        self.itens: deque[tuple[float, list[float]]] = deque()

    def adicionar(self, t_ms: float, p: np.ndarray) -> list[float]:
        self.itens.append((t_ms, p.tolist()))
        while self.itens and self.itens[0][0] <= t_ms - JANELA_MS:
            self.itens.popleft()
        return np.mean(np.asarray([v for _, v in self.itens]), axis=0).tolist()


def predizer(modelo, imagem_rgb: np.ndarray) -> tuple[list[float], str, float]:
    inicio = time.perf_counter()
    saida = modelo.predict_on_batch(imagem_rgb[np.newaxis].astype(np.float32))
    ms = (time.perf_counter() - inicio) * 1000
    p = np.asarray(saida, dtype=float)[0]
    if len(p) != 3 or np.any(p < -1e-6) or np.any(p > 1 + 1e-6) or abs(p.sum() - 1) > 1e-3:
        raise ValueError(f"saída inválida da CNN: {p.tolist()}")
    return p.tolist(), CLASSES[int(np.argmax(p))], ms


def resultado(p, classe, ms, media):
    return {"probabilidades": dict(zip(CLASSES, p)), "classe": classe, "ms": ms,
            "media": dict(zip(CLASSES, media))}


class Comparador:
    def __init__(self, caminho: Path, caminho_olhos: Path = MODELO_OLHOS_PADRAO):
        import keras
        self.caminho = caminho.resolve()
        self.sha256 = hashlib.sha256(self.caminho.read_bytes()).hexdigest().upper()
        if self.sha256 != HASH_ESPERADO:
            raise ValueError(f"SHA-256 inesperado: {self.sha256}")
        self.modelo = keras.models.load_model(self.caminho, compile=False)
        if tuple(self.modelo.input_shape[1:]) != (TAMANHO, TAMANHO, 3):
            raise ValueError(f"entrada inesperada: {self.modelo.input_shape}")
        if int(self.modelo.output_shape[-1]) != 3:
            raise ValueError(f"saídas inesperadas: {self.modelo.output_shape}")
        self.meta = {"caminho": str(self.caminho), "sha256": self.sha256,
                     "entrada": list(self.modelo.input_shape), "saidas": 3,
                     "classes": CLASSES, "modelo_correto": True}
        self.modelo_olhos = None
        self.detector_olhos = None
        self.meta_olhos = {"estado": "indisponivel", "caminho": str(caminho_olhos.resolve())}
        try:
            caminho_olhos = caminho_olhos.resolve()
            if not caminho_olhos.is_file():
                raise FileNotFoundError(f"modelo de olhos não encontrado: {caminho_olhos}")
            if not CASCADE_PADRAO.is_file():
                raise FileNotFoundError(f"cascade facial não encontrado: {CASCADE_PADRAO}")
            detector = criar_cascade(cv2, CASCADE_PADRAO)
            if detector.empty():
                raise RuntimeError(f"cascade facial inválido: {CASCADE_PADRAO}")
            modelo_olhos = keras.models.load_model(caminho_olhos, compile=False)
            if tuple(modelo_olhos.input_shape[1:]) != (TAMANHO, TAMANHO, 3):
                raise ValueError(f"entrada inesperada na CNN V3: {modelo_olhos.input_shape}")
            if int(modelo_olhos.output_shape[-1]) != 1:
                raise ValueError(f"saída inesperada na CNN V3: {modelo_olhos.output_shape}")
            self.modelo_olhos, self.detector_olhos = modelo_olhos, detector
            self.meta_olhos = {
                "estado": "pronto", "caminho": str(caminho_olhos),
                "sha256": hashlib.sha256(caminho_olhos.read_bytes()).hexdigest().upper(),
                "entrada": list(modelo_olhos.input_shape), "saidas": 1,
                "classe_positiva": "olhos_fechados",
                "preprocessamento": "haar_frontalface_8pct_rgb160",
                "limiar": 0.5,
            }
        except Exception as erro:
            self.meta_olhos["motivo"] = f"{type(erro).__name__}: {erro}"
            print(f"[DIAGNOSTICO_V3] Indisponível; V2 continua ativa: {self.meta_olhos['motivo']}")


async def sessao(ws, comparador: Comparador):
    medias = {"inteiro": Media(), "rosto": Media()}
    await ws.send(json.dumps({"tipo": "pronto", "modelo": comparador.meta,
                              "modelo_olhos": comparador.meta_olhos, "janela_ms": JANELA_MS}))
    meta_pendente = None
    try:
        async for mensagem in ws:
            if isinstance(mensagem, str):
                meta_pendente = json.loads(mensagem)
                continue
            if meta_pendente is None:
                continue
            meta, meta_pendente = meta_pendente, None
            w, h = int(meta["largura"]), int(meta["altura"])
            if len(mensagem) != w * h * 3:
                raise ValueError("tamanho de quadro inválido")
            rgb = np.frombuffer(mensagem, np.uint8).reshape(h, w, 3)
            rosto, caixa_pixels = preparar_rosto(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), meta.get("caixa"))
            pi, ci, msi = predizer(comparador.modelo, preparar_inteiro(rgb))
            mi = medias["inteiro"].adicionar(float(meta["t_ms"]), np.asarray(pi))
            rosto_resultado = None
            if rosto is not None:
                pr, cr, msr = predizer(comparador.modelo, rosto)
                mr = medias["rosto"].adicionar(float(meta["t_ms"]), np.asarray(pr))
                rosto_resultado = resultado(pr, cr, msr, mr)
            v3 = {"estado": comparador.meta_olhos["estado"], "probabilidade_olhos_fechados": None,
                  "olhos_fechados": None, "limiar": 0.5, "inferencia_ms": None, "caixa_pixels": None,
                  "motivo": comparador.meta_olhos.get("motivo")}
            if comparador.modelo_olhos is not None:
                recorte_v3, caixa_v3 = preparar_olhos_v3(rgb, comparador.detector_olhos)
                v3["caixa_pixels"] = caixa_v3
                if recorte_v3 is None:
                    v3["estado"] = "sem_recorte_facial"
                else:
                    try:
                        inicio = time.perf_counter()
                        p_v3 = np.asarray(comparador.modelo_olhos.predict_on_batch(
                            recorte_v3[np.newaxis].astype(np.float32)), dtype=float).reshape(-1)
                        v3["inferencia_ms"] = (time.perf_counter() - inicio) * 1000
                        if p_v3.size != 1 or not np.isfinite(p_v3[0]) or not 0 <= p_v3[0] <= 1:
                            raise ValueError(f"probabilidade inválida da CNN V3: {p_v3.tolist()}")
                        v3["estado"] = "observado"
                        v3["probabilidade_olhos_fechados"] = float(p_v3[0])
                        v3["olhos_fechados"] = bool(p_v3[0] >= v3["limiar"])
                    except Exception as erro:
                        v3["estado"] = "erro"
                        v3["motivo"] = f"{type(erro).__name__}: {erro}"
                        comparador.modelo_olhos = None
                        comparador.meta_olhos["estado"] = "indisponivel"
                        comparador.meta_olhos["motivo"] = v3["motivo"]
                        print(f"[DIAGNOSTICO_V3] Inferência interrompida; V2 continua ativa: {v3['motivo']}")
            await ws.send(json.dumps({"tipo": "comparacao", "quadro": meta["quadro"],
                "t_ms": meta["t_ms"], "etapa": meta.get("etapa", "SEM_ETAPA"),
                "ear": meta.get("ear"), "caixa": caixa_pixels,
                "caixa_origem": meta.get("caixa_origem"),
                "mediapipe": {"face_detectada": meta.get("caixa") is not None,
                    "ear": meta.get("ear"), "caixa_normalizada": meta.get("caixa"),
                    "caixa_origem": meta.get("caixa_origem")},
                "v3": v3,
                "inteiro": resultado(pi, ci, msi, mi), "rosto": rosto_resultado}, ensure_ascii=False))
    except Exception as erro:
        print(f"[COMPARADOR] sessão encerrada: {type(erro).__name__}: {erro}")


async def principal(args):
    from websockets.asyncio.server import serve
    comparador = Comparador(args.modelo)
    print("[COMPARADOR_META] " + json.dumps(comparador.meta, ensure_ascii=False))
    http = ThreadingHTTPServer(("127.0.0.1", args.http), partial(SemCache, directory=str(RAIZ)))
    threading.Thread(target=http.serve_forever, daemon=True).start()
    print(f"Comparador: http://localhost:{args.http}/simulador/diagnostico-cnn.html")
    async with serve(partial(sessao, comparador=comparador), "127.0.0.1", args.ws, max_size=64 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Comparador experimental da CNN V2")
    parser.add_argument("--modelo", type=Path, default=MODELO_PADRAO)
    parser.add_argument("--modelo-olhos", type=Path, default=MODELO_OLHOS_PADRAO)
    parser.add_argument("--http", type=int, default=8001)
    parser.add_argument("--ws", type=int, default=8766)
    try:
        asyncio.run(principal(parser.parse_args()))
    except KeyboardInterrupt:
        print("\nComparador encerrado")
