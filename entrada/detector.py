"""Pontos do rosto do motorista com o MediaPipe Face Landmarker."""

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python import vision

from entrada.contexto import RAIZ
from entrada.recorte import maior_rosto


class DetectorRosto:
    """Modo vídeo do MediaPipe: síncrono, um quadro por chamada, em ordem.

    Procura até max_rostos rostos e devolve só o maior, em pixels (N, 2), para
    que pessoas ao fundo não sejam recortadas no lugar do motorista.
    """

    def __init__(self, config: dict):
        mpc = config["mediapipe"]
        opcoes = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(RAIZ / mpc["modelo"])),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=mpc["max_rostos"],
            min_face_detection_confidence=mpc["min_confianca_deteccao"],
            min_face_presence_confidence=mpc["min_confianca_presenca"],
            min_tracking_confidence=mpc["min_confianca_rastreio"],
        )
        self._landmarker = vision.FaceLandmarker.create_from_options(opcoes)
        self._ultimo_t = -1

    def detectar(self, quadro_bgr, t_ms: int):
        """Pontos do maior rosto em pixels, ou None se não houver rosto."""
        # O MediaPipe exige marcas de tempo estritamente crescentes.
        t_ms = max(int(t_ms), self._ultimo_t + 1)
        self._ultimo_t = t_ms
        rgb = cv2.cvtColor(quadro_bgr, cv2.COLOR_BGR2RGB)
        resultado = self._landmarker.detect_for_video(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), t_ms)
        altura, largura = quadro_bgr.shape[:2]
        rostos = [np.array([(p.x * largura, p.y * altura) for p in rosto])
                  for rosto in resultado.face_landmarks]
        return maior_rosto(rostos)

    def fechar(self) -> None:
        self._landmarker.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()
