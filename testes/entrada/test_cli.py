"""Linha de comando: análise em tempo real, escolha de câmera, janela e erros."""

import json
import time

import numpy as np
import pytest

from entrada.__main__ import (Analisador, _linhas_do_terminal, _quadros_das_webcams, desenhar,
                              escolher_cameras, janela_ativa, main)
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
    imprimiu = [analisador.processar(np.zeros((8, 8, 3), np.uint8), t).mostrar_resumo
                for t in range(0, 3000, 100)]
    assert classificador.chamadas == 30                       # todo quadro vai ao modelo
    assert [t for t, i in zip(range(0, 3000, 100), imprimiu) if i] == [0, 1000, 2000]
    resumo = analisador.processar(np.zeros((8, 8, 3), np.uint8), 3000).resumo
    assert resumo.probabilidades["alerta"] == pytest.approx(0.6, abs=0.02)  # média de 0,9 e 0,3


class DetectorSemRosto:
    def detectar(self, _quadro, _t_ms):
        return None


def test_analisador_guarda_o_estado_do_rosto_do_quadro():
    from entrada.rosto import LimiaresRosto, MonitorRosto
    analisador = Analisador(ClassificadorFalso(), DetectorSemRosto(),
                            monitor=MonitorRosto(LimiaresRosto()))
    estado = analisador.processar(np.zeros((8, 8, 3), np.uint8), 0).estado
    assert estado.olhos is None and estado.eventos == []


def test_analisador_sem_detector_nao_procura_o_rosto():
    analisador = Analisador(ClassificadorFalso(), janela_ms=2000, intervalo_terminal_ms=1000)
    analise = analisador.processar(np.zeros((8, 8, 3), np.uint8), 0)
    assert analise.rosto is None and analise.estado is None


@tem_modelo_ia
def test_video_mostra_uma_linha_por_segundo_e_nao_grava_nada(tmp_path, capsys, monkeypatch):
    antes = sorted(p for p in RAIZ.rglob("*") if p.is_file() and ".git" not in p.parts)
    monkeypatch.chdir(tmp_path)
    assert main(["video", str(VIDEO)]) == 0
    saida = capsys.readouterr().out.splitlines()
    linhas = [l for l in saida if l.startswith("[rgb") and "média" in l]
    # Em 1 s o vídeo está na tela preta (1 a 1,5 s): sem motorista, sem média.
    assert [l[:14] for l in linhas] == ["[rgb    0,0 s]", "[rgb    2,0 s]", "[rgb    3,0 s]"]
    assert "[rgb    1,0 s] motorista não visível: análise pausada" in saida
    assert all("alerta" in l or "sonolento" in l for l in linhas)
    # Quadros sem motorista não são analisados: com a tela preta na janela de 2 s, a taxa
    # cai; em 3 s a janela já saiu dela e volta a 1 análise por quadro (30 q/s).
    assert "q/s" not in linhas[0] and all("q/s" in l for l in linhas[1:])
    assert linhas[-1].endswith("· 30 q/s")
    # Uma linha por quadro com o que o modelo devolveu e o estado do rosto.
    logs = [l for l in saida if "saída [" in l]
    assert len(logs) == 104 and logs[1].startswith("[rgb    0,033 s] saída [")
    assert all(" | " in l for l in logs)
    assert "olhos abertos (EAR " in logs[0] and "boca fechada" in logs[0] and "cabeça " in logs[0]
    assert all("rosto não detectado" not in l for l in logs)   # sem rosto, nem vai ao modelo
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
    from entrada.rosto import Rosto
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


@tem_modelo_ia
def test_sem_log_mostra_so_as_medias(capsys):
    assert main(["video", str(VIDEO), "--sem-log"]) == 0
    saida = capsys.readouterr().out
    assert "saída [" not in saida and saida.count("média") == 3   # 1 s: sem motorista


def test_desenho_mostra_olhos_e_boca_no_painel():
    from entrada.rosto import EstadoRosto
    estado = EstadoRosto("fechados", 0.05, "aberta", 0.6, "baixo")
    quadro = np.zeros((320, 400, 3), np.uint8)
    desenhar(quadro, None, None, None, estado)
    assert quadro[50:80, :200].any()   # linhas extras no painel


def test_linhas_do_terminal_com_e_sem_log():
    from entrada.__main__ import Analise
    from entrada.rosto import EstadoRosto
    resultado = Resultado("alerta", {"alerta": 0.9, "sonolento": 0.1}, saida=[0.9, 0.1], ms=20)
    estado = EstadoRosto("abertos", 0.3, "fechada", 0.02, "frente", eventos=["piscada (0,15 s)"])
    analise = Analise(resultado, resultado, 18.0, None, estado, mostrar_resumo=True)
    linhas = _linhas_do_terminal("rgb", 1500, analise, sem_log=False, janela_s="2")
    assert linhas == [
        "[rgb    1,500 s] saída [0,9000 0,1000] → alerta (20 ms) | "
        "olhos abertos (EAR 0,30) · boca fechada (0,02) · cabeça frente",
        "[rgb    1,500 s] evento: piscada (0,15 s)",
        "[rgb    1,5 s] média 2 s: alerta 90,0%  (sonolento 10,0%)  · 18 q/s",
    ]
    assert _linhas_do_terminal("rgb", 1500, analise, sem_log=True, janela_s="2") == linhas[1:]


# ---- motorista visível, sensor de pressão e junção -------------------------

class DetectorComRosto:
    def detectar(self, _quadro, _t_ms):
        return rosto_sintetico()


class SensorFalso:
    """Leituras fixas do volante, como o SensorPressao."""

    def __init__(self, valores):
        self.valores = valores

    def leituras_desde(self, _t_ms):
        return [(0, v) for v in self.valores]


def analisador_completo(detector, sensor=None):
    from entrada.contexto import carregar_pontos_rosto
    from entrada.pressao import Fusao
    from entrada.rosto import LimiaresRosto, MonitorRosto
    return Analisador(ClassificadorFalso(), detector, monitor=MonitorRosto(LimiaresRosto(), carregar_pontos_rosto()),
                      sensor=sensor, fusao=Fusao(0.6, 0.4, 0.6, 0.4), limiar_pressao=400)


def test_sem_motorista_na_camera_nao_ha_analise_nem_alerta():
    analisador = analisador_completo(DetectorSemRosto(), SensorFalso([100, 100]))
    quadro = np.zeros((8, 8, 3), np.uint8)
    analises = [analisador.processar(quadro, t) for t in range(0, 1000, 100)]
    assert analisador.classificador.chamadas == 0          # o modelo nem é chamado
    assert all(not a.visivel and a.resultado is None and a.indice is None for a in analises)
    eventos = [e for a in analises for e in a.eventos]
    assert eventos == ["motorista não visível: análise pausada"]   # só na transição


def test_motorista_volta_e_a_analise_retoma_com_o_sensor():
    sensor = SensorFalso([100, 100, 100, 900])               # 75% abaixo de 400
    analisador = analisador_completo(DetectorComRosto(), sensor)
    analise = analisador.processar(np.zeros((8, 8, 3), np.uint8), 0)
    assert analise.visivel and analise.fracao_sensor == pytest.approx(0.75)
    assert analise.pressao == 900
    # ClassificadorFalso: 1ª chamada dá sonolento 0,1 → índice 0,6·0,1 + 0,4·0,75 = 0,36
    assert analise.indice == pytest.approx(0.36)


def test_alerta_de_sonolencia_quando_modelo_e_volante_concordam():
    class ClassificadorSono:
        def classificar(self, _q):
            return Resultado("sonolento", {"alerta": 0.1, "sonolento": 0.9}, saida=[0.1, 0.9], ms=5)

    analisador = analisador_completo(DetectorComRosto(), SensorFalso([100] * 10))
    analisador.classificador = ClassificadorSono()
    analise = analisador.processar(np.zeros((8, 8, 3), np.uint8), 0)
    assert any(e.startswith("ALERTA de sonolência") for e in analise.eventos)
    linhas = _linhas_do_terminal("rgb", 0, analise, sem_log=True, janela_s="2")
    assert any("ALERTA de sonolência" in l for l in linhas)   # alerta aparece mesmo com --sem-log
    assert any("índice de sonolência 0,94" in l and "volante" in l for l in linhas)


def test_linhas_sem_motorista():
    analisador = analisador_completo(DetectorSemRosto())
    analise = analisador.processar(np.zeros((8, 8, 3), np.uint8), 0)
    linhas = _linhas_do_terminal("rgb", 0, analise, sem_log=False, janela_s="2")
    assert linhas == ["[rgb    0,000 s] motorista não visível: sem análise",
                      "[rgb    0,000 s] evento: motorista não visível: análise pausada",
                      "[rgb    0,0 s] motorista não visível: análise pausada"]


@tem_modelo_ia
def test_video_nao_analisa_os_quadros_sem_rosto(capsys):
    assert main(["video", str(VIDEO)]) == 0
    saida = capsys.readouterr().out.splitlines()
    analisados = [l for l in saida if "saída [" in l]
    sem_rosto = [l for l in saida if "motorista não visível: sem análise" in l]
    assert len(analisados) == 104 and len(sem_rosto) == 16   # tela preta: quadros 30 a 45
    assert any("evento: motorista não visível" in l for l in saida)
    assert any("evento: motorista visível: análise retomada" in l for l in saida)


def test_sensor_ausente_avisa_e_segue_sem_ele(capsys):
    from entrada.__main__ import _abrir_sensor
    config = carregar_config()
    config["sensor"]["porta"] = "/dev/nao_existe_fsr402"
    assert _abrir_sensor(config, relogio_ms=lambda: 0) is None
    assert "sensor de pressão indisponível" in capsys.readouterr().err
