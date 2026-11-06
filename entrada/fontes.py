"""Fontes de vídeo: arquivo e webcam.

Ambas entregam tuplas (quadro_bgr, t_ms, indice). Nenhuma grava vídeo.
"""

import math
import os
import threading
import time
from pathlib import Path

import cv2


class FonteArquivo:
    """Lê um arquivo de vídeo quadro a quadro.

    A marca de tempo é indice * 1000 / fps arredondado com a metade para cima,
    e não a posição informada pelo decodificador, que varia entre formatos.
    """

    def __init__(self, caminho, abrir=cv2.VideoCapture):
        self.caminho = str(caminho)
        if not Path(self.caminho).is_file():
            raise FileNotFoundError(f"Arquivo de vídeo não encontrado: {self.caminho}")
        self._cap = abrir(self.caminho)
        if not self._cap.isOpened():
            raise OSError(f"Não foi possível abrir o vídeo: {self.caminho}")
        self.fps = self._cap.get(cv2.CAP_PROP_FPS)
        if not self.fps or self.fps <= 0:
            raise ValueError(f"FPS desconhecido no vídeo: {self.caminho}")
        self.total = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))

    def __iter__(self):
        indice = 0
        while True:
            ok, quadro = self._cap.read()
            if not ok:
                return
            yield quadro, math.floor(indice * 1000 / self.fps + 0.5), indice
            indice += 1

    def fechar(self) -> None:
        self._cap.release()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()


class FonteWebcam:
    """Lê a webcam em uma thread separada e guarda só o quadro mais recente.

    A leitura do OpenCV bloqueia; com ela fora do laço principal, o
    processamento nunca espera pela câmera e nunca trabalha num quadro velho.
    O t_ms vem de um relógio monotônico iniciado na abertura da câmera, ou em t0.
    """

    def __init__(self, dispositivo=0, largura=None, altura=None, abrir=cv2.VideoCapture,
                 t0: float | None = None):
        self._cap = abrir(dispositivo)
        if not self._cap.isOpened():
            raise OSError(f"Não foi possível abrir a webcam {dispositivo}")
        if largura:
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, largura)
        if altura:
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, altura)
        # Webcams abertas com o mesmo t0 têm marcas de tempo comparáveis entre si.
        self._t0 = time.monotonic() if t0 is None else t0
        self._condicao = threading.Condition()
        self._ultimo = None
        self._entregue = -1
        self._rodando = True
        self._thread = threading.Thread(target=self._ler, name="captura-webcam", daemon=True)
        self._thread.start()

    def agora_ms(self) -> float:
        """Milissegundos no relógio desta webcam (o mesmo do t_ms dos quadros)."""
        return (time.monotonic() - self._t0) * 1000

    def _ler(self) -> None:
        # Só esta thread usa a câmera, inclusive para liberá-la: um release()
        # vindo de outra thread no meio de um read() pode travar ou derrubar o
        # processo com alguns drivers.
        indice = 0
        try:
            while self._rodando:
                ok, quadro = self._cap.read()
                if not ok:
                    break
                with self._condicao:
                    self._ultimo = (quadro, int(self.agora_ms()), indice)
                    self._condicao.notify_all()
                indice += 1
        finally:
            self._cap.release()
            with self._condicao:
                self._rodando = False
                self._condicao.notify_all()

    def ler(self, timeout: float = 1.0):
        """Devolve o quadro mais recente ainda não entregue, ou None.

        Quadros capturados enquanto o laço principal estava ocupado são
        descartados. Devolve None se a câmera parar ou o tempo esgotar.
        """
        with self._condicao:
            self._condicao.wait_for(
                lambda: not self._rodando
                or (self._ultimo is not None and self._ultimo[2] > self._entregue),
                timeout,
            )
            if self._ultimo is None or self._ultimo[2] <= self._entregue:
                return None
            self._entregue = self._ultimo[2]
            return self._ultimo

    @property
    def ativa(self) -> bool:
        return self._rodando

    def fechar(self, timeout: float = 2.0) -> None:
        """Pede o fim da captura e espera a thread por até `timeout` segundos.

        Se a câmera estiver presa num read(), a thread libera a câmera quando
        ele voltar; fechar() não a libera por conta própria.
        """
        self._rodando = False
        self._thread.join(timeout=timeout)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()


# ---- câmeras do sistema ------------------------------------------------------

def _apelido(descricao: str) -> str:
    """Nome curto para a linha de comando, a partir do nome "aparelho: câmera" do driver.

    "Insta360 Link 2: Insta360 Link" vira "insta360-link-2"; "HD Webcam: IR Camera",
    em que a 2ª parte diz qual das câmeras do aparelho é, vira "ir-camera".
    """
    aparelho, _, camera = (p.strip().lower() for p in descricao.partition(":"))
    base = camera if camera and not aparelho.startswith(camera) else aparelho
    return "-".join("".join(c if c.isalnum() else " " for c in base).split()) or "camera"


def detectar_cameras(raiz=Path("/sys/class/video4linux"), largura: int = 640,
                     altura: int = 480) -> list[dict]:
    """Câmeras ligadas ao computador (Linux), no formato de `cameras` da configuração.

    Cada câmera USB cria dois ou mais /dev/videoN; só o de índice 0 entrega imagem. O
    tamanho pedido é só uma preferência: o driver escolhe o mais próximo que a câmera tem.
    Fora do Linux, ou sem permissão para ler, a lista vem vazia.
    """
    def numero(pasta):
        sufixo = pasta.name[len("video"):]
        return int(sufixo) if sufixo.isdigit() else 1 << 30

    cameras, usados = [], set()
    for pasta in sorted(Path(raiz).glob("video*"), key=numero):
        try:
            if (pasta / "index").read_text().strip() != "0":
                continue
            descricao = (pasta / "name").read_text().strip()
        except OSError:
            continue
        nome, n = _apelido(descricao), 2
        while nome in usados:
            nome, n = f"{_apelido(descricao)}-{n}", n + 1
        usados.add(nome)
        cameras.append({"nome": nome, "descricao": descricao, "dispositivo": f"/dev/{pasta.name}",
                        "largura": largura, "altura": altura})
    return cameras


def juntar_cameras(configuradas: list, detectadas: list) -> dict:
    """As câmeras da configuração e, depois delas, as detectadas que não estão nela.

    A comparação é pelo dispositivo de fato (os caminhos by-path e by-id da configuração
    apontam para um /dev/videoN).
    """
    def real(dispositivo):
        return os.path.realpath(dispositivo) if isinstance(dispositivo, str) else dispositivo

    cameras = {c["nome"]: c for c in configuradas}
    ja = {real(c["dispositivo"]) for c in configuradas}
    for c in detectadas:
        if real(c["dispositivo"]) in ja:
            continue
        nome = c["nome"] if c["nome"] not in cameras else f"{c['nome']}-{len(cameras) + 1}"
        cameras[nome] = {**c, "nome": nome}
    return cameras
