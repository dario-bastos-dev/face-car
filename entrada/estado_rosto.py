"""Olhos, boca e cabeça a partir dos pontos do rosto, com eventos que dependem do tempo.

Isto não vem do modelo cnn_sonolencia.keras, que só diz alerta ou sonolento: vem da
geometria do rosto (MediaPipe), com as mesmas fórmulas do extrator de métricas
(entrada/geometria.py). Os limiares estão em config/analise.json e precisam ser
ajustados com gravações reais.
"""

from dataclasses import dataclass, field

from entrada import geometria
from entrada.formato import numero
from entrada.mapa import rotulo_da_cabeca


@dataclass
class LimiaresRosto:
    ear_olho_fechado: float = 0.18     # EAR abaixo disto: olho fechado
    piscada_max_ms: int = 400          # fechado por até isto e reaberto: piscada
    olhos_fechados_alerta_ms: int = 1000
    abertura_boca_aberta: float = 0.40
    bocejo_min_ms: int = 1500          # aberta por menos que isto: fala, não bocejo


@dataclass
class EstadoRosto:
    olhos: str | None                  # "abertos", "fechados" ou None sem rosto
    ear: float | None
    boca: str | None                   # "aberta", "fechada" ou None sem rosto
    abertura: float | None
    cabeca: str | None                 # "frente", "baixo", "esquerda"... ou None
    eventos: list = field(default_factory=list)


def medidas(pontos, indices: dict) -> tuple[float, float]:
    """(EAR médio dos dois olhos, abertura da boca), como no extrator de métricas."""
    ear = (geometria.ear(pontos[indices["olho_esquerdo"]])
           + geometria.ear(pontos[indices["olho_direito"]])) / 2
    a, b = indices["boca_cantos"]
    abertura = geometria.abertura_boca(
        [(pontos[x], pontos[y]) for x, y in indices["boca_pares_verticais"]], pontos[a], pontos[b])
    return ear, abertura


def _duracao(ms: float) -> str:
    return f"{numero(ms / 1000, '.2f')} s"


class MonitorRosto:
    """Acompanha olhos e boca quadro a quadro e anuncia piscadas, olhos fechados e bocejos."""

    def __init__(self, limiares: LimiaresRosto, indices: dict | None = None):
        self.limiares = limiares
        self.indices = indices
        self._olhos_fechados_desde = None
        self._alertou_olhos = False
        self._boca_aberta_desde = None
        self._alertou_bocejo = False

    def atualizar(self, t_ms: int, rosto) -> EstadoRosto:
        """Estado deste quadro a partir de um Rosto do detector (ou None)."""
        if rosto is None:
            return self.registrar(t_ms, None, None, None)
        ear, abertura = medidas(rosto.pontos, self.indices)
        cabeca = rotulo_da_cabeca(rosto.matriz) if rosto.matriz is not None else None
        return self.registrar(t_ms, ear, abertura, cabeca)

    def registrar(self, t_ms: int, ear, abertura, cabeca) -> EstadoRosto:
        """Estado e eventos a partir das medidas já calculadas (None sem rosto)."""
        if ear is None:
            # Sem rosto não dá para saber o que aconteceu: recomeça do zero.
            self._olhos_fechados_desde = self._boca_aberta_desde = None
            self._alertou_olhos = self._alertou_bocejo = False
            return EstadoRosto(None, None, None, None, None)

        lim = self.limiares
        eventos = []
        fechados = ear < lim.ear_olho_fechado
        if fechados:
            if self._olhos_fechados_desde is None:
                self._olhos_fechados_desde = t_ms
            if (not self._alertou_olhos
                    and t_ms - self._olhos_fechados_desde >= lim.olhos_fechados_alerta_ms):
                eventos.append("olhos fechados há mais de "
                               f"{numero(lim.olhos_fechados_alerta_ms / 1000, 'g')} s")
                self._alertou_olhos = True
        elif self._olhos_fechados_desde is not None:
            duracao = t_ms - self._olhos_fechados_desde
            if duracao <= lim.piscada_max_ms:
                eventos.append(f"piscada ({_duracao(duracao)})")
            elif self._alertou_olhos:
                eventos.append(f"olhos reabertos após {_duracao(duracao)}")
            else:
                eventos.append(f"olhos fechados por {_duracao(duracao)}")
            self._olhos_fechados_desde = None
            self._alertou_olhos = False

        aberta = abertura > lim.abertura_boca_aberta
        if aberta:
            if self._boca_aberta_desde is None:
                self._boca_aberta_desde = t_ms
            if not self._alertou_bocejo and t_ms - self._boca_aberta_desde >= lim.bocejo_min_ms:
                eventos.append("bocejo")
                self._alertou_bocejo = True
        else:
            self._boca_aberta_desde = None
            self._alertou_bocejo = False

        return EstadoRosto("fechados" if fechados else "abertos", ear,
                           "aberta" if aberta else "fechada", abertura, cabeca, eventos)


def formatar_estado(estado: EstadoRosto) -> str:
    """Ex.: "olhos abertos (EAR 0,31) · boca fechada (0,02) · cabeça baixo"."""
    if estado.olhos is None:
        return "rosto não detectado"
    partes = [f"olhos {estado.olhos} (EAR {numero(estado.ear, '.2f')})",
              f"boca {estado.boca} ({numero(estado.abertura, '.2f')})"]
    if estado.cabeca is not None:
        partes.append(f"cabeça {estado.cabeca}")
    return " · ".join(partes)
