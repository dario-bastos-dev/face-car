"""Classifica o estado do motorista com o modelo Keras treinado (cnn_sonolencia.keras).

O modelo recebe uma imagem RGB quadrada, do tamanho de entrada dele (lido do próprio
modelo), com os pixels de 0 a 255: a normalização é uma camada dentro dele. Qual imagem
depende de como ele foi treinado, e o treino anota isso em <modelo>.classes.json:

- "recorte": "rosto" (a partir do FaceCar_CNN_V4): só o rosto, num quadrado em volta dos
  pontos do MediaPipe (caixa_do_rosto). O simulador recorta com a mesma regra
  (simulador/js/recorte.js), e testes/casos/recorte.json confere que as duas batem.
- sem a chave (FaceCar_CNN_V2 e V3): o quadro inteiro, redimensionado sem recortar.
"""

import json
import math
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


def conferir_classes(caminho_modelo, classes: list) -> None:
    """Confere `classes` com a ordem salva pelo treino em <modelo>.classes.json.

    O notebook de treino (treinamento/modelo.ipynb) grava esse arquivo ao lado do .keras.
    Sem ele (modelos antigos), vale a configuração.
    """
    caminho = Path(caminho_modelo)
    arquivo = caminho.with_name(f"{caminho.stem}.classes.json")
    if not arquivo.is_file():
        return
    do_treino = json.loads(arquivo.read_text(encoding="utf-8"))["classes"]
    if list(classes) != list(do_treino):
        raise ValueError(f"a ordem das classes não bate com a do treino: o modelo devolve "
                         f"[{', '.join(do_treino)}] ({arquivo.name}), mas a configuração diz "
                         f"[{', '.join(classes)}]")


RECORTES = ("quadro", "rosto")
FATOR_RECORTE = 1.4   # lado do quadrado = maior lado da caixa dos pontos do rosto x este fator


def ler_recorte(caminho_modelo) -> str:
    """"rosto" ou "quadro": a imagem com que o modelo foi treinado, em <modelo>.classes.json."""
    caminho = Path(caminho_modelo)
    arquivo = caminho.with_name(f"{caminho.stem}.classes.json")
    if not arquivo.is_file():
        return "quadro"
    return json.loads(arquivo.read_text(encoding="utf-8")).get("recorte", "quadro")


def _arredondar(valor: float) -> int:
    return math.floor(valor + 0.5)   # meio para cima, como o Math.round do JavaScript


def caixa_do_rosto(pontos, largura: int, altura: int, fator: float = FATOR_RECORTE):
    """(x, y, lado) do quadrado do rosto, em pixels, dentro da imagem.

    O quadrado fica centrado na caixa dos pontos, com lado = maior lado dela x `fator`
    (sobra testa, queixo e um pouco de fundo, para a cabeça inclinada caber); perto da
    borda, é empurrado para dentro, e nunca passa do menor lado da imagem.
    """
    pontos = np.asarray(pontos, dtype=float)
    (x0, y0), (x1, y1) = pontos.min(axis=0), pontos.max(axis=0)
    lado = min(max(x1 - x0, y1 - y0) * fator, largura, altura)
    x = min(max((x0 + x1) / 2 - lado / 2, 0), largura - lado)
    y = min(max((y0 + y1) / 2 - lado / 2, 0), altura - lado)
    return _arredondar(x), _arredondar(y), _arredondar(lado)


def recortar_rosto(quadro, pontos) -> np.ndarray:
    """O quadrado do rosto (caixa_do_rosto) recortado do quadro."""
    altura, largura = quadro.shape[:2]
    x, y, lado = caixa_do_rosto(pontos, largura, altura)
    return quadro[y:y + lado, x:x + lado]


def preparar(quadro_bgr, tamanho: int) -> np.ndarray:
    """Imagem em (1, tamanho, tamanho, 3), RGB, float32 de 0 a 255.

    Redimensiona sem recortar, como o carregador de imagens do notebook de treino.
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
    """Aplica o modelo a um quadro; `classes` dá o nome de cada saída, na ordem.

    `recorte` diz a imagem com que o modelo foi treinado: "rosto" ou "quadro" (inteiro).
    """

    def __init__(self, classes: list, modelo, recorte: str = "quadro"):
        saidas = modelo.output_shape[-1]
        if saidas != len(classes):
            raise ValueError(f"o modelo tem {saidas} saídas, mas há {len(classes)} classes "
                             f"configuradas: {classes}")
        if recorte not in RECORTES:
            raise ValueError(f"recorte '{recorte}' desconhecido; use um de {list(RECORTES)}")
        self.classes = list(classes)
        self.recorte = recorte
        self.modelo = modelo
        self.tamanho = modelo.input_shape[1]

    @classmethod
    def carregar(cls, caminho, classes: list) -> "ClassificadorSonolencia":
        caminho = Path(caminho)
        if not caminho.is_file():
            raise FileNotFoundError(f"Modelo não encontrado: {caminho}")
        conferir_classes(caminho, classes)
        import keras  # carregado só quando o modelo é usado: leva alguns segundos

        classificador = cls(classes, keras.models.load_model(caminho, compile=False),
                            ler_recorte(caminho))
        # A primeira chamada monta o grafo e é bem mais lenta; melhor pagar isso agora.
        classificador.classificar(np.zeros((classificador.tamanho,) * 2 + (3,), np.uint8))
        return classificador

    def classificar(self, quadro_bgr, pontos=None) -> Resultado:
        """Classifica o quadro. `pontos` são os do rosto (Rosto.pontos), para o recorte."""
        if self.recorte == "rosto" and pontos is not None:
            quadro_bgr = recortar_rosto(quadro_bgr, pontos)
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
