"""Integração com o MediaPipe, sobre os dados de scripts/preparar.sh."""

import json

import cv2
import numpy as np
import pytest

from entrada.contexto import RAIZ

DADOS = RAIZ / "testes" / "dados"
MODELO = RAIZ / "modelos" / "face_landmarker.task"

pytestmark = pytest.mark.skipif(
    not ((DADOS / "retrato.mp4").exists() and MODELO.exists()),
    reason="rode scripts/preparar.sh para baixar o modelo e gerar o vídeo",
)


@pytest.fixture
def detector():
    from entrada.detector import DetectorRosto

    config = json.loads((RAIZ / "config" / "captura.json").read_text())
    with DetectorRosto(config) as d:
        yield d


def test_rosto_presente_e_ausente(detector):
    from entrada.fontes import FonteArquivo

    with FonteArquivo(DADOS / "retrato.mp4") as fonte:
        achados = {i: detector.detectar(q, t) is not None for q, t, i in fonte}
    assert all(achados[i] for i in range(30))
    assert not any(achados[i] for i in range(30, 46))  # tela preta


def test_escolhe_o_maior_rosto(detector):
    retrato = cv2.imread(str(DADOS / "retrato.jpg"))
    grande = cv2.resize(retrato, (410, 512))
    pequeno = cv2.resize(retrato, (205, 256))
    cena = np.full((512, 700, 3), 128, np.uint8)
    cena[:, :410] = grande
    cena[128:384, 470:675] = pequeno
    rosto = detector.detectar(cena, 0)
    assert rosto is not None
    assert rosto.pontos[:, 0].max() < 410  # o rosto escolhido está no retrato grande
    # A matriz de pose é a do mesmo rosto: de frente, aponta para a câmera (z > 0.9).
    assert rosto.matriz.shape == (4, 4)
    frente = rosto.matriz[:3, 2] / np.linalg.norm(rosto.matriz[:3, 2])
    assert frente[2] > 0.9
