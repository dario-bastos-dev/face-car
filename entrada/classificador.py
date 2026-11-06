"""Classifica o estado do motorista com o modelo Keras treinado (cnn_sonolencia.keras).

O modelo foi treinado com o quadro inteiro da câmera, em RGB, redimensionado para o
tamanho de entrada dele (160x160 no FaceCar_CNN_V2), com os pixels de 0 a 255: a
normalização é uma camada dentro dele. O tamanho é lido do próprio modelo.
"""

import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from entrada.contexto import numero


@dataclass
class Resultado:
    """Classe escolhida e probabilidades por classe.

    `saida` é o vetor exatamente como o modelo devolveu e `ms` o tempo da previsão;
    ficam vazios nas médias, que não vêm de uma previsão só.
    """

    classe: str
    probabilidades: dict
    saida: list | None = None
    ms: float | None = None


def preparar(quadro_bgr, tamanho: int) -> np.ndarray:
    """Quadro inteiro em (1, tamanho, tamanho, 3), RGB, float32 de 0 a 255.

    Redimensiona sem recortar, como o carregador de imagens do Keras faz no treino.
    """
    imagem = cv2.resize(quadro_bgr, (tamanho, tamanho), interpolation=cv2.INTER_LINEAR)
    return cv2.cvtColor(imagem, cv2.COLOR_BGR2RGB)[np.newaxis].astype(np.float32)


def formatar(resultado: Resultado) -> str:
    """Ex.: "sonolento 91,3%  (alerta 8,7%)"."""
    outras = [f"{c} {_pct(p)}" for c, p in resultado.probabilidades.items()
              if c != resultado.classe]
    return f"{formatar_classe(resultado)}  ({', '.join(outras)})"


def formatar_classe(resultado: Resultado) -> str:
    """Só a classe escolhida e a probabilidade dela, ex.: "sonolento 91,3%"."""
    return f"{resultado.classe} {_pct(resultado.probabilidades[resultado.classe])}"


def _pct(p: float) -> str:
    return f"{numero(100 * p, '.1f')}%"


def formatar_saida(resultado: Resultado) -> str:
    """Ex.: "saída [0,9813 0,0187] → alerta (22 ms)"."""
    vetor = " ".join(numero(v, ".4f") for v in resultado.saida)
    return f"saída [{vetor}] → {resultado.classe} ({resultado.ms:.0f} ms)"


def _conferir_probabilidades(p: np.ndarray) -> None:
    """A saída tem de ser uma distribuição: valores de 0 a 1 que somam 1 (softmax).

    Sem isso, um modelo sem softmax ou trocado por engano viraria porcentagens sem
    sentido no terminal; a tolerância cobre só o arredondamento em float32.
    """
    if np.any(p < -1e-6) or np.any(p > 1 + 1e-6):
        raise ValueError(f"a saída do modelo deveria ter valores entre 0 e 1, mas veio "
                         f"{np.round(p, 4).tolist()} (o modelo termina em softmax?)")
    if abs(p.sum() - 1) > 1e-3:
        raise ValueError(f"as {len(p)} saídas do modelo deveriam somar 1, mas somam "
                         f"{p.sum():.4f}: {np.round(p, 4).tolist()}")


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
        # predict_on_batch roda o grafo compilado: ~22 ms por quadro nesta máquina, contra
        # ~160 ms de modelo(x), que executa camada por camada.
        entrada = preparar(quadro_bgr, self.tamanho)
        inicio = time.perf_counter()
        saida = self.modelo.predict_on_batch(entrada)
        ms = (time.perf_counter() - inicio) * 1000
        probabilidades = np.asarray(saida, dtype=float)[0]
        _conferir_probabilidades(probabilidades)
        return Resultado(self.classes[int(np.argmax(probabilidades))],
                         dict(zip(self.classes, probabilidades.tolist())),
                         probabilidades.tolist(), ms)


class MediaTemporal:
    """Média das probabilidades dos quadros dos últimos `janela_ms`.

    Um quadro sozinho engana (uma piscada vira "sonolento"); a média de alguns
    segundos separa a piscada do olho que fica fechado.
    """

    def __init__(self, janela_ms: int):
        self.janela_ms = janela_ms
        self._itens = deque()

    def adicionar(self, t_ms: int, resultado: Resultado) -> None:
        self._itens.append((t_ms, resultado))
        while self._itens and self._itens[0][0] <= t_ms - self.janela_ms:
            self._itens.popleft()

    def resumo(self):
        """(Resultado com a média, quadros por segundo na janela), ou (None, 0.0)."""
        if not self._itens:
            return None, 0.0
        classes = list(self._itens[-1][1].probabilidades)
        media = {c: float(np.mean([r.probabilidades[c] for _, r in self._itens]))
                 for c in classes}
        duracao = self._itens[-1][0] - self._itens[0][0]
        qps = (len(self._itens) - 1) * 1000 / duracao if duracao > 0 else 0.0
        return Resultado(max(media, key=media.get), media), qps
