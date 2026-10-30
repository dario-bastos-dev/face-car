"""Prepara imagens rotuladas do YawDD para o treinamento da CNN.

O script nao cria rotulos. A entrada e um manifesto CSV supervisionado, com
uma linha por video e as colunas video_path,label,driver_id.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import cv2
import numpy as np
from sklearn.model_selection import GroupShuffleSplit

CLASSES = ("bocejo", "sem_bocejo")
REQUIRED = {"video_path", "label", "driver_id"}


def ler_manifesto(caminho: Path, videos_dir: Path | None) -> list[dict[str, str]]:
    with caminho.open(newline="", encoding="utf-8-sig") as arquivo:
        linhas = list(csv.DictReader(arquivo))
    if not linhas:
        raise ValueError("O manifesto esta vazio.")
    faltantes = REQUIRED - set(linhas[0])
    if faltantes:
        raise ValueError(f"Colunas ausentes no manifesto: {sorted(faltantes)}")
    for linha in linhas:
        linha["label"] = linha["label"].strip().lower()
        if linha["label"] not in CLASSES:
            raise ValueError(f"Rotulo invalido: {linha['label']!r}. Use {CLASSES}.")
        caminho_video = Path(linha["video_path"])
        if not caminho_video.is_absolute() and videos_dir:
            caminho_video = videos_dir / caminho_video
        linha["video_path"] = str(caminho_video.resolve())
        if not linha["driver_id"].strip():
            raise ValueError("driver_id nao pode ser vazio.")
    return linhas


def dividir_por_grupo(linhas: list[dict[str, str]], seed: int) -> dict[int, str]:
    # Todos os videos do mesmo motorista ficam no mesmo split.
    grupos = np.array([x["driver_id"] for x in linhas])
    indices = np.arange(len(linhas))
    treino_val, teste = next(GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=seed).split(indices, groups=grupos))
    treino_rel, validacao_rel = next(GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=seed).split(treino_val, groups=grupos[treino_val]))
    saida = {int(i): "teste" for i in teste}
    saida.update({int(treino_val[i]): "treino" for i in treino_rel})
    saida.update({int(treino_val[i]): "validacao" for i in validacao_rel})
    return saida


def recortar_face(frame: np.ndarray, detector: cv2.CascadeClassifier) -> np.ndarray:
    cinza = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = detector.detectMultiScale(cinza, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    if len(faces) == 0:
        return frame
    x, y, largura, altura = max(faces, key=lambda caixa: caixa[2] * caixa[3])
    mx, my = int(largura * 0.15), int(altura * 0.20)
    return frame[max(0, y - my):min(frame.shape[0], y + altura + my), max(0, x - mx):min(frame.shape[1], x + largura + mx)]


def extrair(linhas: list[dict[str, str]], destino: Path, intervalo: int, tamanho: int, seed: int) -> int:
    destino.mkdir(parents=True, exist_ok=True)
    divisao = dividir_por_grupo(linhas, seed)
    detector = cv2.CascadeClassifier(str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"))
    registros: list[dict[str, str | int]] = []
    total = 0
    for indice, item in enumerate(linhas):
        video = Path(item["video_path"])
        if not video.is_file():
            raise FileNotFoundError(f"Video nao encontrado: {video}")
        cap = cv2.VideoCapture(str(video))
        if not cap.isOpened():
            raise RuntimeError(f"Nao foi possivel abrir o video: {video}")
        split, video_id = divisao[indice], video.stem
        numero = salvo = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if numero % intervalo == 0:
                face = cv2.resize(recortar_face(frame, detector), (tamanho, tamanho), interpolation=cv2.INTER_AREA)
                relativo = Path(split) / item["label"] / f"{video_id}_{numero:06d}.jpg"
                caminho = destino / relativo
                caminho.parent.mkdir(parents=True, exist_ok=True)
                if not cv2.imwrite(str(caminho), face, [cv2.IMWRITE_JPEG_QUALITY, 95]):
                    raise OSError(f"Falha ao salvar {caminho}")
                registros.append({"path": relativo.as_posix(), "video_id": video_id, "driver_id": item["driver_id"], "label": item["label"], "split": split, "frame": numero})
                salvo += 1
                total += 1
            numero += 1
        cap.release()
        print(f"{video.name}: {salvo} frames -> {split}/{item['label']}")
    with (destino / "metadata.csv").open("w", newline="", encoding="utf-8") as arquivo:
        escritor = csv.DictWriter(arquivo, fieldnames=["path", "video_id", "driver_id", "label", "split", "frame"])
        escritor.writeheader()
        escritor.writerows(registros)
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--videos-dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "dados" / "yawdd_processado")
    parser.add_argument("--frame-stride", type=int, default=5)
    parser.add_argument("--image-size", type=int, default=96)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if args.frame_stride < 1 or args.image_size < 16:
        parser.error("--frame-stride deve ser >= 1 e --image-size >= 16")
    total = extrair(ler_manifesto(args.manifest, args.videos_dir), args.output_dir, args.frame_stride, args.image_size, args.seed)
    print(f"Concluido: {total} imagens em {args.output_dir}")


if __name__ == "__main__":
    main()

