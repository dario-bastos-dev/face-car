"""Linha de comando: análise em tempo real, escolha de câmera, janela e erros."""

import json
import time

import numpy as np
import pytest

from entrada.__main__ import (Analisador, _quadros_das_webcams, desenhar, escolher_cameras,
                              janela_ativa, main)
from entrada.classificador import Resultado
from entrada.contexto import RAIZ, carregar_config
from entrada.fontes import FonteWebcam
from test_fontes import CameraFalsa

VIDEO = RAIZ / "testes" / "dados" / "retrato.mp4"
MODELO = RAIZ / "modelos" / "face_landmarker.task"
MODELO_IA = RAIZ / "cnn_sonolencia.keras"
tem_dados = pytest.mark.skipif(not (VIDEO.exists() and MODELO.exists()),
                               reason="rode scripts/preparar.sh")
tem_modelo_ia = pytest.mark.skipif(not (MODELO_IA.exists() and VIDEO.exists() and MODELO.exists()),
                                   reason="precisa de cnn_sonolencia.keras e de scripts/preparar.sh")


class ClassificadorFalso:
    """Alterna entre alerta e sonolento a cada chamada, sem TensorFlow."""

    def __init__(self):
        self.chamadas = 0

    def classificar(self, _quadro):
        self.chamadas += 1
        p = 0.9 if self.chamadas % 2 else 0.3
        return Resultado("alerta" if p > 0.5 else "sonolento", {"alerta": p, "sonolento": 1 - p})


def test_analisador_classifica_todo_quadro_e_resume_uma_vez_por_segundo():
    classificador = ClassificadorFalso()
    analisador = Analisador(classificador, janela_ms=2000, intervalo_terminal_ms=1000)
    imprimiu = [analisador.processar(np.zeros((8, 8, 3), np.uint8), t)[2]
                for t in range(0, 3000, 100)]
    assert classificador.chamadas == 30                       # todo quadro vai ao modelo
    assert [t for t, i in zip(range(0, 3000, 100), imprimiu) if i] == [0, 1000, 2000]
    _, resumo, _ = analisador.processar(np.zeros((8, 8, 3), np.uint8), 3000)
    assert resumo.probabilidades["alerta"] == pytest.approx(0.6, abs=0.02)  # média de 0,9 e 0,3


def test_analisador_sem_detector_nao_procura_o_rosto():
    analisador = Analisador(ClassificadorFalso(), janela_ms=2000, intervalo_terminal_ms=1000)
    rosto, _, _ = analisador.processar(np.zeros((8, 8, 3), np.uint8), 0)
    assert rosto is None


@tem_modelo_ia
def test_video_mostra_uma_linha_por_segundo_e_nao_grava_nada(tmp_path, capsys, monkeypatch):
    antes = sorted(p for p in RAIZ.rglob("*") if p.is_file() and ".git" not in p.parts)
    monkeypatch.chdir(tmp_path)
    assert main(["video", str(VIDEO)]) == 0
    linhas = [l for l in capsys.readouterr().out.splitlines() if l.startswith("[rgb")]
    assert [l[:14] for l in linhas] == ["[rgb    0,0 s]", "[rgb    1,0 s]", "[rgb    2,0 s]",
                                         "[rgb    3,0 s]"]
    assert all("alerta" in l or "sonolento" in l for l in linhas)
    assert "q/s" not in linhas[0] and all("30 q/s" in l for l in linhas[1:])  # 1 por quadro
    depois = sorted(p for p in RAIZ.rglob("*") if p.is_file() and ".git" not in p.parts)
    novos = [p for p in set(depois) - set(antes) if "__pycache__" not in p.parts
             and ".pytest_cache" not in p.parts]
    assert novos == [] and list(tmp_path.iterdir()) == []


@tem_dados
def test_modelo_ausente_da_erro_claro(tmp_path, capsys):
    config = carregar_config()
    config["classificador"]["modelo"] = "nao_existe.keras"
    arquivo = tmp_path / "config.json"
    arquivo.write_text(json.dumps(config))
    assert main(["--config", str(arquivo), "video", str(VIDEO)]) == 2
    assert "modelo não encontrado" in capsys.readouterr().err


def test_video_inexistente_da_mensagem_clara(tmp_path, capsys):
    ausente = tmp_path / "nao-existe.mp4"
    assert main(["video", str(ausente)]) == 2
    erro = capsys.readouterr().err
    assert "não encontrado" in erro and str(ausente) in erro
    assert "Traceback" not in erro


def test_arquivo_que_nao_e_video_da_mensagem_clara(tmp_path, capsys):
    falso = tmp_path / "texto.mp4"
    falso.write_text("isto não é um vídeo")
    assert main(["video", str(falso)]) == 2
    assert "Não foi possível abrir o vídeo" in capsys.readouterr().err


def rosto_sintetico():
    from entrada.detector import Rosto
    angulos = np.linspace(0, 2 * np.pi, 478, endpoint=False)
    return Rosto(np.c_[200 + 80 * np.cos(angulos), 210 + 80 * np.sin(angulos)], np.eye(4))


def test_desenho_mostra_o_resultado_e_o_mapeamento():
    from entrada.contexto import carregar_pontos_rosto
    resumo = Resultado("alerta", {"alerta": 0.97, "sonolento": 0.03})
    quadro = np.zeros((320, 400, 3), np.uint8)
    desenhar(quadro, resumo, rosto_sintetico(), carregar_pontos_rosto())
    assert quadro[150:300].any()       # mapeamento do rosto
    assert quadro[:40, :200].any()     # painel com o resultado
    desenhar(np.zeros((320, 400, 3), np.uint8), None, None, None)  # antes do 1º resultado


def test_camera_desconhecida_da_mensagem_clara(tmp_path, capsys):
    assert main(["webcam", "--camera", "termica"]) == 2
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


COM_TELA = {"WAYLAND_DISPLAY": "wayland-1"}


def analisar(*argv):
    import argparse
    from entrada import __main__ as cli
    capturado = {}

    def guardar(args):
        capturado["args"] = args
        return 0
    original = (cli.cmd_video, cli.cmd_webcam)
    cli.cmd_video = cli.cmd_webcam = guardar
    try:
        cli.main(list(argv))
    finally:
        cli.cmd_video, cli.cmd_webcam = original
    return capturado["args"]


def test_webcam_abre_a_janela_por_padrao():
    assert janela_ativa(analisar("webcam"), COM_TELA)
    assert not janela_ativa(analisar("webcam", "--sem-janela"), COM_TELA)


def test_video_so_abre_a_janela_com_mostrar():
    assert not janela_ativa(analisar("video", "x.mp4"), COM_TELA)
    assert janela_ativa(analisar("video", "x.mp4", "--mostrar"), COM_TELA)


def test_sem_tela_nao_abre_a_janela_e_avisa(capsys):
    assert not janela_ativa(analisar("webcam"), {})
    assert "sem tela" in capsys.readouterr().err
