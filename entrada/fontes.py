"""Fontes de vídeo: arquivo e webcam.

Ambas entregam tuplas (quadro_bgr, t_ms, indice). Nenhuma grava vídeo.
"""

import math
import threading
import time

import cv2


class FonteArquivo:
    """Lê um arquivo de vídeo quadro a quadro.

    A marca de tempo é indice * 1000 / fps arredondado com a metade para cima
    (como o Math.round do navegador), e não a posição informada pelo
    decodificador, para que o Python e o navegador usem os mesmos instantes.
    """

    def __init__(self, caminho, abrir=cv2.VideoCapture):
        self.caminho = str(caminho)
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
    O t_ms vem de um relógio monotônico iniciado na abertura da câmera.
    """

    def __init__(self, dispositivo=0, largura=None, altura=None, abrir=cv2.VideoCapture):
        self._cap = abrir(dispositivo)
        if not self._cap.isOpened():
            raise OSError(f"Não foi possível abrir a webcam {dispositivo}")
        if largura:
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, largura)
        if altura:
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, altura)
        self._t0 = time.monotonic()
        self._condicao = threading.Condition()
        self._ultimo = None
        self._entregue = -1
        self._rodando = True
        self._thread = threading.Thread(target=self._ler, name="captura-webcam", daemon=True)
        self._thread.start()

    def agora_ms(self) -> float:
        return (time.monotonic() - self._t0) * 1000

    def _ler(self) -> None:
        indice = 0
        while self._rodando:
            ok, quadro = self._cap.read()
            if not ok:
                break
            with self._condicao:
                self._ultimo = (quadro, int(self.agora_ms()), indice)
                self._condicao.notify_all()
            indice += 1
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

    def fechar(self) -> None:
        self._rodando = False
        self._thread.join(timeout=2)
        self._cap.release()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()
