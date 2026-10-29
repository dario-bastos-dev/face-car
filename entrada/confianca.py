"""Confiança do rastreio a partir da presença do rosto e da estabilidade dos pontos."""

import math
from dataclasses import dataclass

from entrada.geometria import residuo_alinhado


@dataclass
class ParametrosConfianca:
    escala_residuo: float = 0.02
    alfa_suavizacao: float = 0.3
    valor_inicial: float = 0.5
    intervalo_max_ms: int = 500

    @classmethod
    def de_config(cls, config: dict) -> "ParametrosConfianca":
        return cls(**config["confianca"])


class Estabilidade:
    """Acompanha os pontos rígidos quadro a quadro e devolve a confiança.

    - Sem rosto: confiança 0 e o histórico é zerado.
    - Primeiro quadro com rosto, ou depois de um intervalo maior que
      intervalo_max_ms: confiança igual a valor_inicial.
    - Nos demais: o resíduo do alinhamento com o quadro anterior, dividido pela
      distância de referência (entre os cantos externos dos olhos), é suavizado
      por média exponencial, e a confiança é exp(-resíduo / escala_residuo).
    """

    def __init__(self, parametros: ParametrosConfianca):
        self.p = parametros
        self._anterior = None
        self._t_anterior = None
        self._residuo = None

    def atualizar(self, pontos_rigidos, t_ms: int, distancia_ref: float) -> float:
        if pontos_rigidos is None or distancia_ref <= 0:
            self._anterior = self._t_anterior = self._residuo = None
            return 0.0

        continua = (
            self._anterior is not None
            and t_ms - self._t_anterior <= self.p.intervalo_max_ms
        )
        if continua:
            r = residuo_alinhado(self._anterior, pontos_rigidos) / distancia_ref
            if self._residuo is None:
                self._residuo = r
            else:
                a = self.p.alfa_suavizacao
                self._residuo = a * r + (1 - a) * self._residuo
            confianca = math.exp(-self._residuo / self.p.escala_residuo)
        else:
            self._residuo = None
            confianca = self.p.valor_inicial

        self._anterior = pontos_rigidos
        self._t_anterior = t_ms
        return confianca
