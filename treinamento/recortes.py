"""Recorta o rosto das fotos e dos quadros de vídeo do dataset de treino.

O modelo vê só o rosto do motorista (a partir do FaceCar_CNN_V4). No quadro inteiro reduzido
a 224 px, os olhos ocupam poucos pixels, e o que mais muda de um vídeo para outro é roupa,
fundo e luz, e foi isso que o FaceCar_CNN_V3 decorou. O recorte segue a regra da análise em
tempo real (entrada/classificador.py, caixa_do_rosto) com o mesmo detector (MediaPipe Face
Landmarker, opções de config/analise.json), para o modelo receber no uso a mesma imagem do
treino.

Cada recorte fica salvo em treinamento/rostos/<versão>/, espelhando o caminho da imagem
original dentro de treinamento/, com um .json ao lado com as medidas do rosto: abertura dos
olhos (EAR médio), abertura da boca e inclinação vertical da cabeça, com as fórmulas da análise.
O treino usa as medidas para limpar os rótulos dos vídeos (treinamento/rotulos.py). Imagens
sem rosto ganham um arquivo .sem_rosto no lugar. Assim a segunda execução só lê o que já está
pronto.
"""

import json
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


def arquivo_de_medidas(destino_recorte: Path) -> Path:
    """Onde ficam as medidas do rosto recortado."""
    return Path(destino_recorte).with_suffix(".json")


def ler_medidas(destino_recorte: Path) -> dict | None:
    """{"ear", "boca", "cabeca_vertical"} do recorte, ou None se não houver rosto."""
    arquivo = arquivo_de_medidas(destino_recorte)
    return json.loads(arquivo.read_text()) if arquivo.exists() else None


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
        output_facial_transformation_matrixes=True,
    )
    return mp, vision.FaceLandmarker.create_from_options(opcoes)


def detectar(imagem_bgr):
    """(pontos (478, 2) em pixels, matriz 4x4 de pose) do maior rosto, ou None. O maior é o do
    motorista, como na análise (entrada/rosto.py)."""
    global _landmarker
    from entrada.rosto import indice_do_maior_rosto, pontos_em_pixels

    if _landmarker is None:
        _landmarker = _criar_landmarker()
    mp, landmarker = _landmarker
    rgb = cv2.cvtColor(imagem_bgr, cv2.COLOR_BGR2RGB)
    resultado = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    altura, largura = imagem_bgr.shape[:2]
    rostos = [pontos_em_pixels(r, largura, altura) for r in resultado.face_landmarks]
    i = indice_do_maior_rosto(rostos)
    if i is None:
        return None
    return rostos[i], np.asarray(resultado.facial_transformation_matrixes[i])


def pontos_do_maior_rosto(imagem_bgr):
    """Pontos (478, 2) em pixels do maior rosto, ou None."""
    achado = detectar(imagem_bgr)
    return None if achado is None else achado[0]


def medir(pontos, matriz) -> dict:
    """Abertura dos olhos e da boca e inclinação vertical da cabeça (graus, + para cima)."""
    from entrada.contexto import carregar_pontos_rosto
    from entrada.rosto import angulos_da_direcao, direcao_da_cabeca, medidas

    ear, boca = medidas(pontos, carregar_pontos_rosto())
    _, vertical = angulos_da_direcao(direcao_da_cabeca(matriz))
    return {"ear": round(float(ear), 4), "boca": round(float(boca), 4),
            "cabeca_vertical": round(float(vertical), 2)}


def _pronto(saida: Path) -> bool:
    return (saida.exists() and arquivo_de_medidas(saida).exists()) or sem_rosto(saida).exists()


def _recortar_um(par) -> bool:
    origem, saida = par
    saida, marca = Path(saida), sem_rosto(saida)
    if _pronto(saida):
        return not marca.exists()
    saida.parent.mkdir(parents=True, exist_ok=True)
    imagem = cv2.imread(str(origem))
    achado = None if imagem is None else detectar(imagem)
    if achado is None:
        marca.touch()
        return False
    pontos, matriz = achado
    arquivo_de_medidas(saida).write_text(json.dumps(medir(pontos, matriz)))
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
    (~200 MB de memória cada). Recortes antigos, sem o .json das medidas, são refeitos.
    """
    pares = [(str(o), str(d)) for o, d in zip(origens, destinos, strict=True)]
    pendentes = [p for p in pares if not _pronto(Path(p[1]))]
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
