"""O rosto do motorista: detecção com o MediaPipe, olhos, boca e cabeça, e o desenho na janela.

Olhos, boca e cabeça não vêm do modelo cnn_sonolencia.keras, que classifica o quadro
inteiro (sonolento, alerta ou bocejo): vêm da geometria do rosto, com as mesmas fórmulas do extrator de métricas
(entrada/geometria.py). O desenho só vai para a imagem mostrada na tela; a imagem
enviada ao modelo não recebe marcas. Direções são descritas do ponto de vista do
motorista: a câmera não espelha a imagem, então quando ele olha para a esquerda dele,
o rosto e as íris vão para a direita da imagem. O MediaPipe só é importado quando um
detector é criado, porque a importação leva alguns segundos.
"""

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from entrada import geometria
from entrada.contexto import RAIZ, numero


# ---- detecção (MediaPipe) --------------------------------------------------

def pontos_em_pixels(landmarks, largura: int, altura: int) -> np.ndarray:
    """Converte pontos normalizados do MediaPipe em pixels (N, 2).

    As distâncias precisam estar em pixels: em coordenadas normalizadas, uma
    imagem não quadrada distorce o EAR.
    """
    return np.array([(p.x * largura, p.y * altura) for p in landmarks], dtype=float)


def indice_do_maior_rosto(rostos):
    """Índice do rosto de maior área, o de quem está mais perto da câmera, ou None."""
    def area(i):
        (x0, y0), (x1, y1) = rostos[i].min(axis=0), rostos[i].max(axis=0)
        return (x1 - x0) * (y1 - y0)

    return max(range(len(rostos)), key=area, default=None)


def maior_rosto(rostos):
    """O rosto de maior área: o do motorista."""
    i = indice_do_maior_rosto(rostos)
    return None if i is None else rostos[i]


@dataclass
class Rosto:
    """Pontos em pixels (478, 2) e matriz 4x4 de pose do rosto."""

    pontos: np.ndarray
    matriz: np.ndarray


class DetectorRosto:
    """Modo vídeo do MediaPipe: síncrono, um quadro por chamada, em ordem.

    Procura até max_rostos rostos e devolve só o maior, para que pessoas ao
    fundo não sejam recortadas no lugar do motorista.
    """

    def __init__(self, config: dict):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        mpc = config["mediapipe"]
        opcoes = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(RAIZ / mpc["modelo"])),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=mpc["max_rostos"],
            min_face_detection_confidence=mpc["min_confianca_deteccao"],
            min_face_presence_confidence=mpc["min_confianca_presenca"],
            min_tracking_confidence=mpc["min_confianca_rastreio"],
            output_facial_transformation_matrixes=True,
        )
        self._landmarker = vision.FaceLandmarker.create_from_options(opcoes)
        self._ultimo_t = -1

    def detectar(self, quadro_bgr, t_ms: int) -> Rosto | None:
        """O maior rosto do quadro, ou None se não houver rosto."""
        # O MediaPipe exige marcas de tempo estritamente crescentes.
        t_ms = max(int(t_ms), self._ultimo_t + 1)
        self._ultimo_t = t_ms
        rgb = cv2.cvtColor(quadro_bgr, cv2.COLOR_BGR2RGB)
        resultado = self._landmarker.detect_for_video(
            self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb), t_ms)
        altura, largura = quadro_bgr.shape[:2]
        rostos = [pontos_em_pixels(rosto, largura, altura) for rosto in resultado.face_landmarks]
        i = indice_do_maior_rosto(rostos)
        if i is None:
            return None
        return Rosto(rostos[i], np.asarray(resultado.facial_transformation_matrixes[i]))

    def fechar(self) -> None:
        self._landmarker.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.fechar()


# ---- direção da cabeça e do olhar, e desenho na janela ---------------------

LIMIAR_CABECA_GRAUS = 15
LIMIAR_OLHAR = 0.2  # deslocamento da íris, em metades da largura do olho

COR_ROSTO = (255, 200, 0)
COR_OLHOS_BOCA = (90, 200, 90)
COR_IRIS = (255, 120, 255)
COR_CABECA = (0, 220, 255)


def direcao_da_cabeca(matriz) -> np.ndarray:
    """Vetor unitário para onde o rosto aponta, a partir da matriz 4x4 do MediaPipe.

    É o eixo z do modelo do rosto (terceira coluna da rotação), no sistema de
    câmera do MediaPipe: x para a direita da imagem, y para cima, z para a câmera.
    """
    rotacao = np.asarray(matriz, dtype=float)[:3, :3]
    frente = rotacao[:, 2]
    return frente / np.linalg.norm(frente)


def angulos_da_direcao(direcao) -> tuple[float, float]:
    """(horizontal, vertical) em graus: positivos para a direita da imagem e para cima."""
    x, y, z = direcao
    return math.degrees(math.atan2(x, z)), math.degrees(math.atan2(y, z))


def descrever(horizontal: float, vertical: float, limiar: float) -> str:
    """Rótulo como "frente", "baixo" ou "baixo e esquerda", do ponto de vista do motorista."""
    partes = []
    if vertical > limiar:
        partes.append("cima")
    elif vertical < -limiar:
        partes.append("baixo")
    if horizontal > limiar:
        partes.append("esquerda")  # direita da imagem
    elif horizontal < -limiar:
        partes.append("direita")
    return " e ".join(partes) or "frente"


def rotulo_da_cabeca(matriz) -> str:
    """Para onde a cabeça aponta, como "frente" ou "baixo e esquerda"."""
    return descrever(*angulos_da_direcao(direcao_da_cabeca(matriz)), LIMIAR_CABECA_GRAUS)


def _olhos(pontos, indices):
    """Para cada olho: centro, eixo unitário (cantos, para a direita da imagem),
    meia largura e os 5 pontos da íris (o primeiro é o centro)."""
    for olho, iris in (("olho_direito", "iris_direita"), ("olho_esquerdo", "iris_esquerda")):
        a, b = pontos[indices[olho][0]], pontos[indices[olho][3]]
        largura = float(np.linalg.norm(b - a))
        yield (a + b) / 2, (b - a) / largura, largura / 2, pontos[indices[iris]]


def olhar_da_iris(pontos, indices) -> tuple[float, float]:
    """Deslocamento médio das íris em relação ao centro dos olhos.

    Medido ao longo do eixo de cada olho (dx, positivo para a direita da imagem)
    e na perpendicular (dy, positivo para baixo), em metades da largura do olho,
    para que inclinar a cabeça não seja lido como olhar para cima ou para baixo.
    """
    desvios = []
    for centro, eixo, meia, iris in _olhos(pontos, indices):
        normal = np.array([-eixo[1], eixo[0]])
        desvio = iris[0] - centro
        desvios.append((desvio @ eixo / meia, desvio @ normal / meia))
    dx, dy = np.mean(desvios, axis=0)
    return float(dx), float(dy)


def _ponto(p):
    return tuple(int(v) for v in np.round(p))


def desenhar_mapa(quadro, pontos, matriz, indices) -> list[str]:
    """Desenha contornos, íris e setas de direção; devolve as linhas de texto.

    Sem matriz de pose, a seta e o rótulo da cabeça são omitidos.
    """
    def contorno(nome, cor):
        pts = np.round(pontos[indices[nome]]).astype(np.int32)
        cv2.polylines(quadro, [pts], True, cor, 1, cv2.LINE_AA)
        return pts

    contorno("contorno_rosto", COR_ROSTO)
    for nome in ("contorno_olho_esquerdo", "contorno_olho_direito",
                 "contorno_labios_externo", "contorno_labios_interno"):
        for x, y in contorno(nome, COR_OLHOS_BOCA):
            cv2.circle(quadro, (int(x), int(y)), 1, COR_OLHOS_BOCA, -1)

    # Íris e olhar: setas saindo de cada íris, ampliadas para ficarem visíveis.
    dx, dy = olhar_da_iris(pontos, indices)
    for _, eixo, meia, iris in _olhos(pontos, indices):
        centro_iris, borda = iris[0], iris[1:]
        raio = max(1, round(float(np.mean(np.linalg.norm(borda - centro_iris, axis=1)))))
        cv2.circle(quadro, _ponto(centro_iris), raio, COR_IRIS, 1, cv2.LINE_AA)
        normal = np.array([-eixo[1], eixo[0]])
        seta = (dx * eixo + dy * normal) * meia * 3
        if np.hypot(*seta) >= 2:
            cv2.arrowedLine(quadro, _ponto(centro_iris), _ponto(centro_iris + seta), COR_IRIS, 1,
                            cv2.LINE_AA, tipLength=0.3)

    linhas = []
    if matriz is not None:
        direcao = direcao_da_cabeca(matriz)
        a, b = indices["referencia_escala"]
        comprimento = 1.5 * float(np.linalg.norm(pontos[a] - pontos[b]))
        seta = np.array([direcao[0], -direcao[1]]) * comprimento  # imagem com y para baixo
        if np.hypot(*seta) >= 2:
            nariz = pontos[indices["ponta_nariz"]]
            cv2.arrowedLine(quadro, _ponto(nariz), _ponto(nariz + seta), COR_CABECA, 2,
                            cv2.LINE_AA, tipLength=0.25)
        linhas.append("cabeca: " + rotulo_da_cabeca(matriz))
    linhas.append("olhar: " + descrever(dx, -dy, LIMIAR_OLHAR))
    return linhas


# ---- olhos, boca e eventos -------------------------------------------------

@dataclass
class LimiaresRosto:
    ear_olho_fechado: float = 0.18     # EAR abaixo disto: olho fechado
    piscada_max_ms: int = 400          # fechado por até isto e reaberto: piscada
    olhos_fechados_alerta_ms: int = 1000
    fechamento_saturacao_ms: int = 3000  # simulador: olhos fechados por isto = índice 100
    perda_rosto_tolerancia_ms: int = 1000  # simulador: perda curta do rosto mantém o índice
    abertura_boca_aberta: float = 0.40
    bocejo_min_ms: int = 1500          # aberta por menos que isto: fala, não bocejo
    cabeca_baixa_alerta_ms: int = 15000  # cabeça baixa por isto: sinal de sonolência


@dataclass
class EstadoRosto:
    olhos: str | None                  # "abertos", "fechados" ou None sem rosto
    ear: float | None
    boca: str | None                   # "aberta", "fechada" ou None sem rosto
    abertura: float | None
    cabeca: str | None                 # "frente", "baixo", "esquerda"... ou None
    eventos: list = field(default_factory=list)
    cabeca_baixa_ms: int | None = None   # há quanto tempo a cabeça está baixa, ou None
    cabeca_baixa_prolongada: bool = False  # baixa há cabeca_baixa_alerta_ms ou mais


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
    """Acompanha olhos, boca e cabeça quadro a quadro e anuncia piscadas, olhos fechados,
    bocejos e a cabeça baixa por muito tempo."""

    def __init__(self, limiares: LimiaresRosto, indices: dict | None = None):
        self.limiares = limiares
        self.indices = indices
        self._olhos_fechados_desde = None
        self._alertou_olhos = False
        self._boca_aberta_desde = None
        self._alertou_bocejo = False
        self._cabeca_baixa_desde = None
        self._alertou_cabeca = False

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
            self._cabeca_baixa_desde = None
            self._alertou_olhos = self._alertou_bocejo = self._alertou_cabeca = False
            return EstadoRosto(None, None, None, None, None)

        fechados, eventos_olhos = self._acompanhar_olhos(t_ms, ear)
        aberta, eventos_boca = self._acompanhar_boca(t_ms, abertura)
        baixa_ms, eventos_cabeca = self._acompanhar_cabeca(t_ms, cabeca)
        return EstadoRosto("fechados" if fechados else "abertos", ear,
                           "aberta" if aberta else "fechada", abertura, cabeca,
                           eventos_olhos + eventos_boca + eventos_cabeca, baixa_ms,
                           baixa_ms is not None
                           and baixa_ms >= self.limiares.cabeca_baixa_alerta_ms)

    def _acompanhar_olhos(self, t_ms: int, ear: float) -> tuple[bool, list]:
        """(olhos fechados?, eventos): piscada, olhos fechados por muito tempo e reabertura."""
        lim = self.limiares
        if ear < lim.ear_olho_fechado:
            if self._olhos_fechados_desde is None:
                self._olhos_fechados_desde = t_ms
            if (self._alertou_olhos
                    or t_ms - self._olhos_fechados_desde < lim.olhos_fechados_alerta_ms):
                return True, []
            self._alertou_olhos = True
            return True, ["olhos fechados há mais de "
                          f"{numero(lim.olhos_fechados_alerta_ms / 1000, 'g')} s"]

        if self._olhos_fechados_desde is None:
            return False, []
        duracao = t_ms - self._olhos_fechados_desde
        if duracao <= lim.piscada_max_ms:
            evento = f"piscada ({_duracao(duracao)})"
        elif self._alertou_olhos:
            evento = f"olhos reabertos após {_duracao(duracao)}"
        else:
            evento = f"olhos fechados por {_duracao(duracao)}"
        self._olhos_fechados_desde = None
        self._alertou_olhos = False
        return False, [evento]

    def _acompanhar_boca(self, t_ms: int, abertura: float) -> tuple[bool, list]:
        """(boca aberta?, eventos): bocejo quando a boca fica aberta tempo suficiente."""
        lim = self.limiares
        if abertura <= lim.abertura_boca_aberta:
            self._boca_aberta_desde = None
            self._alertou_bocejo = False
            return False, []
        if self._boca_aberta_desde is None:
            self._boca_aberta_desde = t_ms
        if self._alertou_bocejo or t_ms - self._boca_aberta_desde < lim.bocejo_min_ms:
            return True, []
        self._alertou_bocejo = True
        return True, ["bocejo"]

    def _acompanhar_cabeca(self, t_ms: int, cabeca) -> tuple[int | None, list]:
        """(há quantos ms a cabeça está baixa, ou None; eventos).

        Olhar para baixo por pouco tempo (painel, rádio) é normal e não gera evento; só a
        cabeça baixa por `cabeca_baixa_alerta_ms` avisa, e de novo quando ela levanta.
        """
        lim = self.limiares
        if cabeca is None or not cabeca.startswith("baixo"):
            eventos = []
            if self._alertou_cabeca:
                eventos.append("cabeça levantada após "
                               f"{_duracao(t_ms - self._cabeca_baixa_desde)}")
            self._cabeca_baixa_desde = None
            self._alertou_cabeca = False
            return None, eventos
        if self._cabeca_baixa_desde is None:
            self._cabeca_baixa_desde = t_ms
        duracao = t_ms - self._cabeca_baixa_desde
        if self._alertou_cabeca or duracao < lim.cabeca_baixa_alerta_ms:
            return duracao, []
        self._alertou_cabeca = True
        return duracao, ["cabeça baixa há mais de "
                         f"{numero(lim.cabeca_baixa_alerta_ms / 1000, 'g')} s"]


def formatar_estado(estado: EstadoRosto) -> str:
    """Ex.: "olhos abertos (EAR 0,31) · boca fechada (0,02) · cabeça baixo há 4 s"."""
    if estado.olhos is None:
        return "rosto não detectado"
    partes = [f"olhos {estado.olhos} (EAR {numero(estado.ear, '.2f')})",
              f"boca {estado.boca} ({numero(estado.abertura, '.2f')})"]
    if estado.cabeca is not None:
        baixa = estado.cabeca_baixa_ms
        tempo = f" há {baixa // 1000} s" if baixa is not None and baixa >= 1000 else ""
        partes.append(f"cabeça {estado.cabeca}{tempo}")
    return " · ".join(partes)
