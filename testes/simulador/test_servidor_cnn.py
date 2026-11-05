"""Serviço do modelo de imagens do simulador (simulador/servidor.py, WebSocket /cnn).

Usa um modelo falso no lugar do cnn_sonolencia.keras: confere o formato dos quadros que a
página manda, o que chega ao modelo e as respostas com a média da janela.
"""

import asyncio
import importlib.util
import json
import struct
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

websockets = pytest.importorskip("websockets")

RAIZ = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("servidor_simulador", RAIZ / "simulador" / "servidor.py")
servidor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(servidor)

CLASSES = ["sonolento", "alerta", "bocejo"]
CONFIG = {"classificador": {"classes": CLASSES, "janela_ms": 2000}}


class ModeloFalso:
    def __init__(self, saida):
        self.saida, self.entradas = saida, []

    def predict_on_batch(self, x):
        self.entradas.append(x)
        return np.array([self.saida])


def servico_com(modelo, tamanho=4):
    classificador = SimpleNamespace(modelo=modelo, classes=CLASSES, tamanho=tamanho)
    servico = servidor.ServicoCnn(CONFIG, Path("falso.keras"), carregar=lambda *_: classificador)
    servico.pronto.wait(5)
    return servico


def quadro(t_ms, rgb):
    return struct.pack("<d", t_ms) + np.asarray(rgb, np.uint8).tobytes()


def test_decodificar_quadro():
    rgb = np.arange(4 * 4 * 3, dtype=np.uint8).reshape(4, 4, 3)
    t_ms, lido = servidor.decodificar_quadro(quadro(1234.5, rgb), 4)
    assert t_ms == 1234.5 and (lido == rgb).all()
    with pytest.raises(ValueError, match="esperado"):
        servidor.decodificar_quadro(b"\0" * 20, 4)


def test_modelo_ausente_fica_indisponivel(tmp_path):
    servico = servidor.ServicoCnn(CONFIG, tmp_path / "nao_existe.keras")
    assert servico.pronto.wait(30)
    assert servico.classificador is None and "nao_existe.keras" in servico.erro


async def _conversa(servico, quadros):
    async def handler(conexao):
        await servidor.sessao_cnn(conexao, servico)

    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        porta = srv.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{porta}/cnn") as ws:
            respostas = [json.loads(await ws.recv())]
            for q in quadros:
                await ws.send(q)
                respostas.append(json.loads(await ws.recv()))
            return respostas


def test_classifica_os_quadros_da_pagina_e_faz_a_media():
    modelo = ModeloFalso([0.1, 0.7, 0.2])
    rgb = np.full((4, 4, 3), 200, np.uint8)
    respostas = asyncio.run(_conversa(servico_com(modelo), [quadro(0, rgb), quadro(500, rgb)]))
    assert respostas[0] == {"tipo": "cnn_pronto", "tamanho": 4, "classes": CLASSES, "janela_ms": 2000}
    r = respostas[-1]
    assert r["tipo"] == "cnn" and r["classe"] == "alerta" and r["t_ms"] == 500
    assert r["media"]["classe"] == "alerta"
    assert r["media"]["probabilidades"]["bocejo"] == pytest.approx(0.2)
    assert r["qps"] == pytest.approx(2.0)  # 2 quadros em 0,5 s
    # o modelo recebe o quadro como no treino: (1, tamanho, tamanho, 3), float32 de 0 a 255
    entrada = modelo.entradas[0]
    assert entrada.shape == (1, 4, 4, 3) and entrada.dtype == np.float32 and entrada.max() == 200
