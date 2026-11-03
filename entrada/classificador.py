"""Classifica o estado do motorista com o modelo Keras treinado (cnn_sonolencia.keras).

O modelo foi treinado com o quadro inteiro da câmera, em RGB, redimensionado para
96x96, com os pixels de 0 a 255: a normalização é uma camada dentro dele.
"""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Resultado:
    classe: str
    probabilidades: dict


def preparar(quadro_bgr, tamanho: int) -> np.ndarray:
    """Quadro inteiro em (1, tamanho, tamanho, 3), RGB, float32 de 0 a 255.

    Redimensiona sem recortar, como o carregador de imagens do Keras faz no treino.
    """
    imagem = cv2.resize(quadro_bgr, (tamanho, tamanho), interpolation=cv2.INTER_LINEAR)
    return cv2.cvtColor(imagem, cv2.COLOR_BGR2RGB)[np.newaxis].astype(np.float32)


def formatar(resultado: Resultado) -> str:
    """Ex.: "sonolento 91,3%  (alerta 8,7%)"."""
    def pct(p):
        return f"{100 * p:.1f}%".replace(".", ",")

    outras = [f"{c} {pct(p)}" for c, p in resultado.probabilidades.items()
              if c != resultado.classe]
    return f"{resultado.classe} {pct(resultado.probabilidades[resultado.classe])}  ({', '.join(outras)})"


class ClassificadorSonolencia:
    """Aplica o modelo a um quadro; `classes` dá o nome de cada saída, na ordem."""

    def __init__(self, classes: list, modelo):
        saidas = modelo.output_shape[-1]
        if saidas != len(classes):
            raise ValueError(f"o modelo tem {saidas} saídas, mas há {len(classes)} classes "
                             f"configuradas: {classes}")
        self.classes = list(classes)
        self.modelo = modelo
        self.tamanho = modelo.input_shape[1]

    @classmethod
    def carregar(cls, caminho, classes: list) -> "ClassificadorSonolencia":
        caminho = Path(caminho)
        if not caminho.is_file():
            raise FileNotFoundError(f"Modelo não encontrado: {caminho}")
        import keras  # carregado só quando o modelo é usado: leva alguns segundos

        classificador = cls(classes, keras.models.load_model(caminho, compile=False))
        # A primeira chamada monta o grafo e é bem mais lenta; melhor pagar isso agora.
        classificador.classificar(np.zeros((classificador.tamanho,) * 2 + (3,), np.uint8))
        return classificador

    def classificar(self, quadro_bgr) -> Resultado:
        saida = self.modelo(preparar(quadro_bgr, self.tamanho), training=False)
        probabilidades = np.asarray(saida, dtype=float)[0]
        return Resultado(self.classes[int(np.argmax(probabilidades))],
                         dict(zip(self.classes, probabilidades.tolist())))
