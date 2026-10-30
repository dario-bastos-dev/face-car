"""Linha de comando: capturas no vídeo de teste e erros sem traceback."""

import time

import cv2
import numpy as np
import pytest

from entrada.__main__ import _quadros_das_webcams, desenhar, escolher_cameras, main
from entrada.contexto import carregar_config
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
    arquivos = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*") if p.is_file())
    # A tela preta (1 a 1,5 s) adia a segunda captura para o primeiro quadro com rosto.
    # Sem --camera, o vídeo vai para a pasta rgb. Cada captura é só o rosto completo.
    assert arquivos == [f"rgb/alerta/p01_retrato.mp4_{t:09d}ms.jpg" for t in (0, 1533, 2533, 3533)]
    for p in (tmp_path / "rgb" / "alerta").iterdir():
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


@tem_dados
def test_video_com_camera_ir_vai_para_a_pasta_ir(tmp_path):
    assert main(["video", str(VIDEO), "--saida", str(tmp_path), "--camera", "ir",
                 "--intervalo-ms", "100000"]) == 0
    assert {p.relative_to(tmp_path).parts[0] for p in tmp_path.rglob("*.jpg")} == {"ir"}


def test_camera_desconhecida_da_mensagem_clara(tmp_path, capsys):
    assert main(["webcam", "--camera", "termica", "--saida", str(tmp_path)]) == 2
    assert "câmera desconhecida: termica" in capsys.readouterr().err


def test_configuracao_tem_camera_normal_e_infravermelha():
    nomes = [c["nome"] for c in carregar_config()["cameras"]]
    assert nomes == ["rgb", "ir"]


def test_quadros_das_webcams_alternam_entre_as_cameras():
    with FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.003, total=30)) as rgb, \
            FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.004, total=30)) as ir:
        nomes = [nome for nome, _, _ in _quadros_das_webcams({"rgb": rgb, "ir": ir}, None)]
    assert {"rgb", "ir"} <= set(nomes)


def test_quadros_das_webcams_seguem_se_uma_camera_para():
    with FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.002, total=3)) as rgb, \
            FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.002, total=40)) as ir:
        nomes = [nome for nome, _, _ in _quadros_das_webcams({"rgb": rgb, "ir": ir}, None)]
    assert nomes.count("ir") > nomes.count("rgb")


def test_quadros_das_webcams_respeitam_o_tempo_limite():
    with FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.005, total=10**6)) as rgb:
        inicio = time.monotonic()
        quadros = list(_quadros_das_webcams({"rgb": rgb}, 0.2))
        assert 0.2 <= time.monotonic() - inicio < 1.5
    assert quadros


CAMERAS = {
    "rgb": {"nome": "rgb", "descricao": "colorida"},
    "ir": {"nome": "ir", "descricao": "infravermelha"},
}


def respostas(*textos):
    """Imita input(): devolve as respostas em ordem e EOFError quando acabam."""
    fila = list(textos)

    def ler(_prompt=""):
        if not fila:
            raise EOFError
        return fila.pop(0)
    return ler


def test_camera_pedida_na_linha_de_comando_nao_pergunta():
    assert escolher_cameras(["ir"], CAMERAS, "rgb", interativo=True, ler=respostas()) == ["ir"]
    assert escolher_cameras(["todas"], CAMERAS, "rgb", interativo=True, ler=respostas()) == [
        "rgb", "ir"]


def test_sem_terminal_usa_a_camera_padrao():
    assert escolher_cameras(None, CAMERAS, "rgb", interativo=False, ler=respostas()) == ["rgb"]


@pytest.mark.parametrize("resposta, esperado", [
    ("1", ["rgb"]), ("2", ["ir"]), ("3", ["rgb", "ir"]),
    ("ir", ["ir"]), ("todas", ["rgb", "ir"]), ("", ["rgb"]),  # Enter = padrão
])
def test_menu_aceita_numero_nome_ou_enter(resposta, esperado, capsys):
    escolha = escolher_cameras(None, CAMERAS, "rgb", interativo=True, ler=respostas(resposta))
    assert escolha == esperado
    menu = capsys.readouterr().out
    assert "1) rgb - colorida" in menu and "2) ir - infravermelha" in menu and "3) todas" in menu


def test_menu_pergunta_de_novo_se_a_resposta_nao_existe(capsys):
    escolha = escolher_cameras(None, CAMERAS, "rgb", interativo=True, ler=respostas("9", "1"))
    assert escolha == ["rgb"]
    assert "opção inválida" in capsys.readouterr().out


def test_menu_sem_resposta_cancela():
    with pytest.raises(ValueError, match="nenhuma câmera escolhida"):
        escolher_cameras(None, CAMERAS, "rgb", interativo=True, ler=respostas())


def test_configuracao_define_a_camera_padrao():
    config = carregar_config()
    assert config["camera_padrao"] in [c["nome"] for c in config["cameras"]]
