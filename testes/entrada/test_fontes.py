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
    # A 16 fps, o quadro 1 está em 62,5 ms: vira 63, e não 62 como faria o
    # round() do Python, que arredonda empates para o número par.
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


def test_webcams_podem_compartilhar_o_relogio():
    t0 = time.monotonic() - 5  # relógio iniciado 5 s antes da abertura
    with FonteWebcam(abrir=CameraFalsa, t0=t0) as fonte:
        _, t_ms, _ = fonte.ler()
    assert 5000 <= t_ms < 6500


# ---- câmeras do sistema ------------------------------------------------------

def sysfs(tmp_path, dispositivos):
    """Imita /sys/class/video4linux: {"video4": ("Insta360 Link 2: Insta360 Link", 0)}."""
    for nome, (descricao, indice) in dispositivos.items():
        (tmp_path / nome).mkdir()
        (tmp_path / nome / "name").write_text(descricao + "\n")
        (tmp_path / nome / "index").write_text(f"{indice}\n")
    return tmp_path


def test_detecta_so_o_dispositivo_de_imagem_de_cada_camera(tmp_path):
    from entrada.fontes import detectar_cameras
    raiz = sysfs(tmp_path, {
        "video0": ("HD Webcam: HD Webcam", 0), "video1": ("HD Webcam: HD Webcam", 1),
        "video2": ("HD Webcam: IR Camera", 0), "video3": ("HD Webcam: IR Camera", 1),
        "video10": ("Insta360 Link 2: Insta360 Link", 0), "video11": ("Insta360 Link 2: Insta360 Link", 1),
    })
    cameras = detectar_cameras(raiz)
    assert [(c["nome"], c["dispositivo"]) for c in cameras] == [
        ("hd-webcam", "/dev/video0"), ("ir-camera", "/dev/video2"), ("insta360-link-2", "/dev/video10")]
    assert cameras[2]["descricao"] == "Insta360 Link 2: Insta360 Link"


def test_duas_cameras_iguais_ganham_nomes_diferentes(tmp_path):
    from entrada.fontes import detectar_cameras
    raiz = sysfs(tmp_path, {"video0": ("USB Camera: USB Camera", 0), "video2": ("USB Camera: USB Camera", 0)})
    assert [c["nome"] for c in detectar_cameras(raiz)] == ["usb-camera", "usb-camera-2"]


def test_sem_sysfs_nao_detecta_nada(tmp_path):
    from entrada.fontes import detectar_cameras
    assert detectar_cameras(tmp_path / "nao_existe") == []


def test_juntar_nao_repete_as_cameras_da_configuracao(tmp_path):
    from entrada.fontes import juntar_cameras
    (tmp_path / "video0").touch()
    (tmp_path / "by-path").symlink_to(tmp_path / "video0")
    configuradas = [{"nome": "rgb", "dispositivo": str(tmp_path / "by-path")}]
    detectadas = [{"nome": "hd-webcam", "dispositivo": str(tmp_path / "video0")},
                  {"nome": "insta360-link-2", "dispositivo": "/dev/video4"}]
    assert list(juntar_cameras(configuradas, detectadas)) == ["rgb", "insta360-link-2"]
