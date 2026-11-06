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


def test_camera_pedida_pelo_dispositivo(tmp_path):
    from entrada.__main__ import _nome_da_camera
    cameras = dict(CAMERAS)
    (tmp_path / "video4").touch()
    # fora da lista, mas existe: entra com o próprio caminho como nome
    assert escolher_cameras([str(tmp_path / "video4")], cameras, "rgb", interativo=False) == [
        str(tmp_path / "video4")]
    assert cameras[str(tmp_path / "video4")]["dispositivo"] == str(tmp_path / "video4")
    # um atalho para uma câmera da lista usa o nome dela
    (tmp_path / "atalho").symlink_to(tmp_path / "video4")
    cameras = {"insta360-link-2": {"nome": "insta360-link-2", "dispositivo": str(tmp_path / "video4")}}
    assert _nome_da_camera(str(tmp_path / "atalho"), cameras) == "insta360-link-2"
    with pytest.raises(ValueError, match="câmera desconhecida"):
        escolher_cameras([str(tmp_path / "nao_existe")], cameras, "rgb", interativo=False)
    with pytest.raises(ValueError, match="câmera desconhecida"):
        escolher_cameras(["webcam-que-nao-existe"], cameras, "rgb", interativo=False)


def test_menu_lista_as_cameras_detectadas(capsys):
    cameras = {**CAMERAS, "insta360-link-2": {"nome": "insta360-link-2", "descricao": "Insta360 Link 2: Insta360 Link",
                                               "dispositivo": "/dev/video4"}}
    assert escolher_cameras(None, cameras, "rgb", interativo=True, ler=respostas("3")) == ["insta360-link-2"]
    assert "3) insta360-link-2 - Insta360 Link 2" in capsys.readouterr().out
    assert escolher_cameras(["insta360-link-2"], cameras, "rgb", interativo=False) == ["insta360-link-2"]


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
    from entrada.pressao import Fusao, PressaoBaixa
    from entrada.rosto import LimiaresRosto, MonitorRosto
    return Analisador(ClassificadorFalso(), detector, monitor=MonitorRosto(LimiaresRosto(), carregar_pontos_rosto()),
                      sensor=sensor, fusao=Fusao(0.6, 0.4, 0.3, 0.3),
                      pressao_baixa=PressaoBaixa(400, 15000))


def test_sem_motorista_na_camera_nao_ha_analise_nem_alerta():
    analisador = analisador_completo(DetectorSemRosto(), SensorFalso([100, 100]))
    quadro = np.zeros((8, 8, 3), np.uint8)
    analises = [analisador.processar(quadro, t) for t in range(0, 1000, 100)]
    assert analisador.classificador.chamadas == 0          # o modelo nem é chamado
    assert all(not a.visivel and a.resultado is None and a.indice is None for a in analises)
    eventos = [e for a in analises for e in a.eventos]
    assert eventos == ["motorista não visível: análise pausada"]   # só na transição


class SensorNoTempo:
    """Uma leitura a cada 50 ms com `valor(t)`, até o instante `agora` do quadro."""

    def __init__(self, valor):
        self.valor = valor
        self.agora = 0

    def leituras_desde(self, t_ms):
        return [(t, self.valor(t)) for t in range(0, self.agora + 1, 50) if t >= t_ms]


class ClassificadorFixo:
    def __init__(self, p_sono):
        self.p = p_sono

    def classificar(self, _q):
        return Resultado("alerta", {"alerta": 1 - self.p, "sonolento": self.p},
                         saida=[1 - self.p, self.p], ms=5)


def rodar(analisador, sensor, instantes, detector_em=None):
    """Processa um quadro em cada instante, com o sensor andando junto."""
    analises = {}
    for t in instantes:
        sensor.agora = t
        if detector_em is not None:
            analisador.detector = detector_em(t)
        analises[t] = analisador.processar(np.zeros((8, 8, 3), np.uint8), t)
    return analises


def test_volante_frouxo_por_15_s_aumenta_o_indice():
    sensor = SensorNoTempo(lambda t: 100)                     # mão solta o tempo todo
    analisador = analisador_completo(DetectorComRosto(), sensor)
    analisador.classificador = ClassificadorFixo(0.2)
    analises = rodar(analisador, sensor, range(0, 16001, 500))
    assert analises[14500].indice == pytest.approx(0.2)      # menos de 15 s: só o modelo
    assert analises[15000].indice == pytest.approx(0.5)      # 15 s: + 0,3
    assert analises[15000].bonus_volante == pytest.approx(0.3)
    assert analises[15000].eventos == ["pressão no volante abaixo de 400 há mais de 15 s"]
    assert not analises[16000].em_alerta                     # 0,5: ainda abaixo de 0,6
    linhas = _linhas_do_terminal("rgb", 16000, analises[16000], sem_log=False, janela_s="2")
    assert linhas[0].endswith("| volante 100 (baixo há 16 s)")
    assert linhas[-1].endswith("índice de sonolência 0,50 (modelo 0,20 · volante frouxo +0,30) → alerta")


def test_alerta_de_sonolencia_quando_modelo_e_volante_concordam():
    sensor = SensorNoTempo(lambda t: 100)
    analisador = analisador_completo(DetectorComRosto(), sensor)
    analisador.classificador = ClassificadorFixo(0.4)
    analises = rodar(analisador, sensor, range(0, 15001, 500))
    assert not analises[14500].em_alerta and analises[15000].em_alerta
    assert "ALERTA de sonolência (índice 0,70: modelo 0,40, volante frouxo +0,30)" in analises[15000].eventos
    linhas = _linhas_do_terminal("rgb", 15000, analises[15000], sem_log=True, janela_s="2")
    assert any("ALERTA de sonolência" in l for l in linhas)   # alerta aparece mesmo com --sem-log


def test_apertar_o_volante_ou_sair_da_camera_recomeca_a_contagem():
    # aperta o volante aos 8 s; some da câmera entre 20 e 21 s
    sensor = SensorNoTempo(lambda t: 900 if 8000 <= t < 8100 else 100)
    analisador = analisador_completo(DetectorComRosto(), sensor)
    analisador.classificador = ClassificadorFixo(0.2)
    analises = rodar(analisador, sensor, range(0, 30001, 500),
                     lambda t: DetectorSemRosto() if 20000 <= t <= 21000 else DetectorComRosto())
    assert analises[22500].bonus_volante == 0.0              # 8,1 s → 22,5 s, mas sumiu no meio
    assert analises[21500].pressao_baixa_ms == 450           # recomeçou na 1ª leitura ao voltar (21,05 s)
    assert analises[19500].bonus_volante == 0.0 and analises[19500].pressao_baixa_ms == 11400
    assert analises[29500].bonus_volante == 0.0 and analises[30000].bonus_volante == 0.0
    assert analises[30000].pressao_baixa_ms == 8950


def test_sensor_mudo_nao_conta_como_volante_frouxo():
    class SensorMudo:
        def leituras_desde(self, _t):
            return []

    analisador = analisador_completo(DetectorComRosto(), SensorMudo())
    analise = analisador.processar(np.zeros((8, 8, 3), np.uint8), 20000)
    assert analise.pressao is None and analise.pressao_baixa_ms is None and analise.bonus_volante == 0


def test_cabeca_baixa_prolongada_aumenta_o_indice():
    from entrada.pressao import Fusao
    from entrada.rosto import EstadoRosto

    class MonitorCabecaBaixa:
        def atualizar(self, _t_ms, _rosto):
            return EstadoRosto("abertos", 0.3, "fechada", 0.02, "baixo", [], 16000, True)

    analisador = Analisador(ClassificadorFalso(), DetectorComRosto(), monitor=MonitorCabecaBaixa(),
                            fusao=Fusao(0.6, 0.4, bonus_cabeca_baixa=0.3))
    analise = analisador.processar(np.zeros((8, 8, 3), np.uint8), 0)
    # ClassificadorFalso: sonolento 0,1; sem sensor, índice = 0,1 + 0,3
    assert analise.bonus_cabeca == pytest.approx(0.3) and analise.indice == pytest.approx(0.4)
    linhas = _linhas_do_terminal("rgb", 0, analise, sem_log=True, janela_s="2")
    assert linhas[-1] == ("[rgb    0,0 s] índice de sonolência 0,40 (modelo 0,10 · "
                          "cabeça baixa +0,30) → alerta")


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
