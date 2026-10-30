"""Linha de comando: capturas no vídeo de teste e erros sem traceback."""

import time

import cv2
import numpy as np
import pytest

from entrada.__main__ import _quadros_da_webcam, desenhar, main
from entrada.contexto import RAIZ
from entrada.fontes import FonteWebcam
from entrada.recorte import Caixa
from test_fontes import CameraFalsa

VIDEO = RAIZ / "testes" / "dados" / "retrato.mp4"
MODELO = RAIZ / "modelos" / "face_landmarker.task"
tem_dados = pytest.mark.skipif(not (VIDEO.exists() and MODELO.exists()),
                               reason="rode scripts/preparar.sh")


@tem_dados
def test_video_grava_um_recorte_por_intervalo(tmp_path):
    codigo = main(["video", str(VIDEO), "--saida", str(tmp_path),
                   "--rotulo", "alerta", "--pessoa", "p01", "--intervalo-ms", "1000"])
    assert codigo == 0
    arquivos = sorted(p.name for p in tmp_path.rglob("*") if p.is_file())
    # A tela preta (1 a 1,5 s) adia a segunda captura para o primeiro quadro com rosto.
    assert arquivos == [f"p01_retrato.mp4_{t:09d}ms.jpg" for t in (0, 1533, 2533, 3533)]
    for p in (tmp_path / "alerta").iterdir():
        assert cv2.imread(str(p)).shape == (224, 224, 3)


def test_video_inexistente_da_mensagem_clara(tmp_path, capsys):
    ausente = tmp_path / "nao-existe.mp4"
    assert main(["video", str(ausente), "--saida", str(tmp_path)]) == 2
    erro = capsys.readouterr().err
    assert "não encontrado" in erro and str(ausente) in erro
    assert "Traceback" not in erro


@tem_dados
def test_arquivo_que_nao_e_video_da_mensagem_clara(tmp_path, capsys):
    falso = tmp_path / "texto.mp4"
    falso.write_text("isto não é um vídeo")
    assert main(["video", str(falso), "--saida", str(tmp_path)]) == 2
    assert "Não foi possível abrir o vídeo" in capsys.readouterr().err


@tem_dados
def test_rotulo_invalido_da_mensagem_clara(tmp_path, capsys):
    assert main(["video", str(VIDEO), "--saida", str(tmp_path), "--rotulo", "../fora"]) == 2
    assert "rótulo inválido" in capsys.readouterr().err


def test_desenho_da_janela_com_e_sem_rosto():
    quadro = np.zeros((240, 320, 3), np.uint8)
    desenhar(quadro, Caixa(160, 140, 100), capturou=True, total=3)
    assert (quadro[90:190, 110] == (0, 255, 0)).all(axis=1).any()  # borda verde ao capturar
    desenhar(np.zeros((240, 320, 3), np.uint8), None, capturou=False, total=3)


def test_quadros_da_webcam_terminam_quando_a_camera_para():
    with FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.001, total=20)) as fonte:
        indices = [i for _, _, i in _quadros_da_webcam(fonte, None)]
    assert indices and indices == sorted(set(indices)) and indices[-1] <= 19


def test_quadros_da_webcam_respeitam_o_tempo_limite():
    with FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.005, total=10**6)) as fonte:
        inicio = time.monotonic()
        quadros = list(_quadros_da_webcam(fonte, 0.2))
        assert 0.2 <= time.monotonic() - inicio < 1.5
    assert quadros
