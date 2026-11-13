"""Recorta o rosto das fotos e dos quadros de vídeo do dataset de treino.

O modelo vê só o rosto do motorista (a partir do FaceCar_CNN_V4). No quadro inteiro reduzido
a 224 px, os olhos ocupam poucos pixels, e o que mais muda de um vídeo para outro é roupa,
fundo e luz, e foi isso que o FaceCar_CNN_V3 decorou. O recorte segue a regra da análise em
tempo real (entrada/classificador.py, caixa_do_rosto) com o mesmo detector (MediaPipe Face
Landmarker, opções de config/analise.json), para o modelo receber no uso a mesma imagem do
treino.

Cada recorte fica salvo em treinamento/rostos/<versão>/, espelhando o caminho da imagem
original dentro de treinamento/. Imagens sem rosto ganham um arquivo .sem_rosto no lugar.
Assim a segunda execução só lê o que já está pronto.
"""

import multiprocessing
import os
from pathlib import Path

import cv2
import numpy as np

from entrada.classificador import FATOR_RECORTE, recortar_rosto
from entrada.contexto import RAIZ, carregar_config

LADO_MAXIMO = 448   # recortes maiores são reduzidos: o modelo usa 224, e o disco agradece

_landmarker = None


def versao() -> str:
    """Nome da pasta dos recortes: muda junto com a regra, para não misturar recortes."""
    return f"fator{FATOR_RECORTE}-max{LADO_MAXIMO}"


def destino(origem: Path, raiz: Path, pasta_rostos: Path) -> Path:
    """Onde fica o recorte de `origem` (que está dentro de `raiz`)."""
    return Path(pasta_rostos) / Path(origem).relative_to(raiz)


def sem_rosto(destino_recorte: Path) -> Path:
    """Marca de que a imagem não tem rosto (ou não abre)."""
    return Path(destino_recorte).with_suffix(".sem_rosto")


def _criar_landmarker():
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    mpc = carregar_config()["mediapipe"]
    opcoes = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(RAIZ / mpc["modelo"])),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=mpc["max_rostos"],
        min_face_detection_confidence=mpc["min_confianca_deteccao"],
        min_face_presence_confidence=mpc["min_confianca_presenca"],
    )
    return mp, vision.FaceLandmarker.create_from_options(opcoes)


def pontos_do_maior_rosto(imagem_bgr):
    """Pontos (478, 2) em pixels do maior rosto, ou None. O maior é o do motorista, como na
    análise (entrada/rosto.py)."""
    global _landmarker
    from entrada.rosto import maior_rosto, pontos_em_pixels

    if _landmarker is None:
        _landmarker = _criar_landmarker()
    mp, landmarker = _landmarker
    rgb = cv2.cvtColor(imagem_bgr, cv2.COLOR_BGR2RGB)
    resultado = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    altura, largura = imagem_bgr.shape[:2]
    return maior_rosto([pontos_em_pixels(r, largura, altura) for r in resultado.face_landmarks])


def _recortar_um(par) -> bool:
    origem, saida = par
    saida, marca = Path(saida), sem_rosto(saida)
    if saida.exists():
        return True
    if marca.exists():
        return False
    saida.parent.mkdir(parents=True, exist_ok=True)
    imagem = cv2.imread(str(origem))
    pontos = None if imagem is None else pontos_do_maior_rosto(imagem)
    if pontos is None:
        marca.touch()
        return False
    rosto = recortar_rosto(imagem, pontos)
    if rosto.shape[0] > LADO_MAXIMO:
        rosto = cv2.resize(rosto, (LADO_MAXIMO, LADO_MAXIMO), interpolation=cv2.INTER_AREA)
    temporario = saida.with_name(f".{saida.name}")   # sem arquivo pela metade se parar no meio
    cv2.imwrite(str(temporario), rosto, [cv2.IMWRITE_JPEG_QUALITY, 95])
    os.replace(temporario, saida)
    return True


def recortar(origens, destinos, processos: int | None = None) -> list[bool]:
    """Recorta o rosto de cada origem para o destino correspondente.

    Devolve, para cada uma, se há rosto. Usa vários processos, cada um com o seu detector
    (~200 MB de memória cada).
    """
    pares = [(str(o), str(d)) for o, d in zip(origens, destinos, strict=True)]
    pendentes = [p for p in pares if not Path(p[1]).exists() and not sem_rosto(Path(p[1])).exists()]
    processos = processos or min(6, os.cpu_count() or 1)
    if processos == 1 or len(pendentes) < 2:
        return [_recortar_um(p) for p in pares]
    # spawn: o MediaPipe não se dá bem com fork; os filhos importam este módulo do zero
    with multiprocessing.get_context("spawn").Pool(processos) as pool:
        list(pool.imap_unordered(_recortar_um, pendentes, chunksize=16))
    return [_recortar_um(p) for p in pares]   # agora só lê o que ficou salvo


def resumo_sem_rosto(tem_rosto, rotulos, nomes) -> str:
    """Quantas imagens de cada classe ficaram sem rosto."""
    tem_rosto, rotulos = np.asarray(tem_rosto), np.asarray(rotulos)
    linhas = [f"{nome:<10} {np.sum(~tem_rosto & (rotulos == i)):>5} de {np.sum(rotulos == i):>5} sem rosto"
              for i, nome in enumerate(nomes)]
    return "\n".join(linhas)
