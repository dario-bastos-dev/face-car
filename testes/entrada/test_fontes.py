import threading
import time

import cv2
import numpy as np

from entrada.fontes import FonteArquivo, FonteWebcam


def test_fonte_arquivo_marca_tempo_por_indice(tmp_path):
    caminho = str(tmp_path / "v.avi")
    escritor = cv2.VideoWriter(caminho, cv2.VideoWriter_fourcc(*"MJPG"), 25, (64, 48))
    for i in range(10):
        escritor.write(np.full((48, 64, 3), i * 20, np.uint8))
    escritor.release()

    with FonteArquivo(caminho) as fonte:
        itens = list(fonte)
    assert fonte.fps == 25
    assert [t for _, t, _ in itens] == [i * 40 for i in range(10)]
    assert [i for _, _, i in itens] == list(range(10))


class CameraFalsa:
    """Imita cv2.VideoCapture produzindo quadros numerados em ritmo fixo."""

    def __init__(self, _dispositivo, intervalo=0.005, total=200):
        self.intervalo, self.total, self.n = intervalo, total, 0

    def isOpened(self):
        return True

    def set(self, *_):
        return True

    def read(self):
        if self.n >= self.total:
            return False, None
        time.sleep(self.intervalo)
        self.n += 1
        return True, np.full((4, 4, 3), self.n % 256, np.uint8)

    def release(self):
        pass


def test_webcam_entrega_so_o_quadro_mais_recente():
    with FonteWebcam(abrir=CameraFalsa) as fonte:
        primeiro = fonte.ler()
        time.sleep(0.1)  # laço principal "ocupado": a câmera segue capturando
        segundo = fonte.ler()
        assert segundo[2] > primeiro[2] + 5  # quadros intermediários foram descartados
        assert segundo[1] >= primeiro[1]


def test_webcam_nao_repete_quadro():
    with FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.02)) as fonte:
        indices = [fonte.ler()[2] for _ in range(5)]
    assert indices == sorted(set(indices))


def test_webcam_encerrada_devolve_none():
    with FonteWebcam(abrir=lambda d: CameraFalsa(d, intervalo=0.001, total=3)) as fonte:
        time.sleep(0.05)
        fonte.ler()
        assert fonte.ler(timeout=0.2) is None
        assert not fonte.ativa


def test_marca_de_tempo_arredonda_metade_para_cima(tmp_path):
    # A 16 fps, o quadro 1 está em 62,5 ms. O JS usa Math.round (63); o round()
    # do Python arredondaria para o par (62) e as duas versões divergiriam.
    caminho = str(tmp_path / "v16.avi")
    escritor = cv2.VideoWriter(caminho, cv2.VideoWriter_fourcc(*"MJPG"), 16, (64, 48))
    for i in range(4):
        escritor.write(np.full((48, 64, 3), i * 40, np.uint8))
    escritor.release()

    with FonteArquivo(caminho) as fonte:
        assert [t for _, t, _ in fonte] == [0, 63, 125, 188]


class CameraTravada(CameraFalsa):
    """Entrega um quadro e depois trava no read() até `destravar` ser acionado."""

    def __init__(self, _dispositivo):
        super().__init__(_dispositivo, intervalo=0.001, total=10**6)
        self.destravar = threading.Event()
        self.lendo = False
        self.liberada = threading.Event()
        self.liberada_durante_leitura = False

    def read(self):
        self.lendo = True
        try:
            if self.n >= 1:
                self.destravar.wait(5)
            return super().read()
        finally:
            self.lendo = False

    def release(self):
        self.liberada_durante_leitura = self.lendo
        self.liberada.set()


def test_fechar_nao_libera_a_camera_no_meio_de_uma_leitura():
    camera = None

    def abrir(dispositivo):
        nonlocal camera
        camera = CameraTravada(dispositivo)
        return camera

    fonte = FonteWebcam(abrir=abrir)
    assert fonte.ler(timeout=1) is not None
    time.sleep(0.05)  # a thread já está presa no segundo read()
    fonte.fechar(timeout=0.1)
    assert not camera.liberada.is_set(), "liberou enquanto o read() ainda rodava"

    camera.destravar.set()  # o read() termina: a própria thread libera a câmera
    assert camera.liberada.wait(2)
    assert not camera.liberada_durante_leitura


def test_camera_que_para_sozinha_e_liberada():
    camera = None

    def abrir(dispositivo):
        nonlocal camera
        camera = CameraTravada(dispositivo)
        camera.total = 2
        camera.destravar.set()
        return camera

    with FonteWebcam(abrir=abrir) as fonte:
        assert camera.liberada.wait(2)  # o read() falhou e a thread encerrou
        assert not fonte.ativa
