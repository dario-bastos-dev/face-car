import importlib.util
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np

RAIZ = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("diagnostico_cnn", RAIZ / "simulador" / "diagnostico_cnn.py")
diagnostico = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostico)
spec_servidor = importlib.util.spec_from_file_location("servidor_simulador", RAIZ / "simulador" / "servidor.py")
servidor = importlib.util.module_from_spec(spec_servidor)
spec_servidor.loader.exec_module(servidor)


def test_preparar_rosto_reproduz_margem_proporcao_e_padding():
    frame = np.zeros((100, 200, 3), dtype=np.uint8)
    frame[:, :, 0] = 255
    rosto, caixa = diagnostico.preparar_rosto(frame, {"xmin": .25, "ymin": .2, "width": .25, "height": .4})
    assert rosto.shape == (160, 160, 3)
    assert caixa == [40, 12, 110, 68]
    assert rosto[0, 0].tolist() == [0, 0, 0]
    assert rosto[:, :, 2].max() == 255


def test_preparar_inteiro_preserva_rgb_e_formato():
    frame = np.zeros((100, 200, 3), dtype=np.uint8)
    frame[:, :, 0] = 255
    inteiro = diagnostico.preparar_inteiro(frame)
    assert inteiro.shape == (160, 160, 3)
    assert inteiro.dtype == np.uint8 and inteiro[:, :, 0].max() == 255


def test_preparar_v3_tem_paridade_com_recorte_do_runtime():
    class Detector:
        def detectMultiScale(self, _cinza, **_kwargs):
            return np.array([[20, 10, 70, 80], [5, 5, 60, 60]])

    frame = np.arange(120 * 140 * 3, dtype=np.uint8).reshape(120, 140, 3)
    imagem, caixa = diagnostico.preparar_olhos_v3(frame, Detector())
    runtime = servidor.preparar_rosto_olhos(frame, Detector())
    assert caixa == [15, 4, 95, 96]
    np.testing.assert_array_equal(imagem, runtime)


def test_preparar_v3_sem_rosto_nao_inventa_recorte():
    class Detector:
        def detectMultiScale(self, _cinza, **_kwargs):
            return ()

    imagem, caixa = diagnostico.preparar_olhos_v3(np.zeros((100, 100, 3), dtype=np.uint8), Detector())
    assert imagem is None and caixa is None


def test_sessao_expoe_predicao_v3_e_estado_mediapipe():
    class ModeloFalso:
        def __init__(self, saida):
            self.saida = saida
            self.entradas = []

        def predict_on_batch(self, x):
            self.entradas.append(x)
            return np.asarray([self.saida])

    class Detector:
        def detectMultiScale(self, _cinza, **_kwargs):
            return np.array([[20, 10, 70, 80]])

    comparador = object.__new__(diagnostico.Comparador)
    comparador.modelo = ModeloFalso([0.2, 0.6, 0.2])
    comparador.meta = {"sha256": "v2"}
    comparador.meta_olhos = {"estado": "pronto"}
    comparador.modelo_olhos = ModeloFalso([0.8])
    comparador.detector_olhos = Detector()

    class WebSocketFalso:
        async def send(self, texto):
            self.mensagens.append(json.loads(texto))

        def __init__(self):
            self.mensagens = []

        def __aiter__(self):
            async def mensagens():
                yield json.dumps({"largura": 140, "altura": 120, "quadro": 1,
                    "t_ms": 100, "caixa": {"xmin": .1, "ymin": .1, "width": .5, "height": .6},
                    "ear": .24, "caixa_origem": "FaceLandmarker_landmarks"})
                yield np.zeros((120, 140, 3), dtype=np.uint8).tobytes()
            return mensagens()

    ws = WebSocketFalso()
    asyncio.run(diagnostico.sessao(ws, comparador))
    resposta = ws.mensagens[-1]
    assert resposta["tipo"] == "comparacao"
    assert resposta["v3"]["estado"] == "observado"
    assert resposta["v3"]["probabilidade_olhos_fechados"] == 0.8
    assert resposta["v3"]["olhos_fechados"] is True
    assert resposta["mediapipe"]["face_detectada"] is True
    assert resposta["mediapipe"]["ear"] == 0.24
    assert comparador.modelo_olhos.entradas[0].shape == (1, 160, 160, 3)
