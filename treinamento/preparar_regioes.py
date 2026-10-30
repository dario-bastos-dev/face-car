"""Prepara datasets reais de olhos e boca para as CNNs do Face-Car.

Manifesto de olhos (CEW, patches ja recortados): image_path,label,person_id
Manifesto de boca (YawDD, videos): video_path,label,driver_id
Os rotulos precisam existir nas fontes; este script nao os infere.
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
from pathlib import Path

import cv2
import numpy as np
from sklearn.model_selection import GroupShuffleSplit

CLASSES = {"olhos": ("aberto", "fechado"), "boca": ("bocejo", "sem_bocejo")}


def ler_manifesto(caminho: Path, raiz: Path | None, regiao: str) -> list[dict[str, str]]:
    with caminho.open(newline="", encoding="utf-8-sig") as arquivo:
        linhas = list(csv.DictReader(arquivo))
    chave_fonte = "image_path" if regiao == "olhos" else "video_path"
    chave_grupo = "person_id" if regiao == "olhos" else "driver_id"
    obrigatorias = {chave_fonte, "label", chave_grupo}
    if not linhas:
        raise ValueError("O manifesto esta vazio.")
    faltantes = obrigatorias - set(linhas[0])
    if faltantes:
        raise ValueError(f"Colunas ausentes: {sorted(faltantes)}")
    for linha in linhas:
        linha["label"] = linha["label"].strip().lower()
        if linha["label"] not in CLASSES[regiao]:
            raise ValueError(f"Rotulo invalido: {linha['label']!r}; use {CLASSES[regiao]}")
        fonte = Path(linha[chave_fonte])
        if not fonte.is_absolute() and raiz:
            fonte = raiz / fonte
        linha[chave_fonte] = str(fonte.resolve())
        linha["grupo"] = linha[chave_grupo].strip()
        if not linha["grupo"]:
            raise ValueError(f"{chave_grupo} nao pode ser vazio.")
    return linhas


def dividir_por_grupo(linhas: list[dict[str, str]], seed: int) -> dict[int, str]:
    grupos = np.array([linha["grupo"] for linha in linhas])
    indices = np.arange(len(linhas))
    if len(np.unique(grupos)) < 3:
        raise ValueError("Sao necessarios pelo menos 3 pessoas/motoristas para treino, validacao e teste.")
    treino_val, teste = next(GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=seed).split(indices, groups=grupos))
    treino_rel, validacao_rel = next(GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=seed).split(treino_val, groups=grupos[treino_val]))
    saida = {int(i): "teste" for i in teste}
    saida.update({int(treino_val[i]): "treino" for i in treino_rel})
    saida.update({int(treino_val[i]): "validacao" for i in validacao_rel})
    return saida


class RecortadorMediaPipe:
    def __init__(self, modelo: Path, regiao: str):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision

        if not modelo.is_file():
            raise FileNotFoundError(f"Modelo MediaPipe nao encontrado: {modelo}")
        self._mp = mp
        self._regiao = regiao
        self._landmarker = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(modelo)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=1,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        ))
        pontos = json.loads((Path(__file__).parent.parent / "entrada" / "pontos_rosto.json").read_text(encoding="utf-8"))
        if regiao == "boca":
            self._indices = sorted(set(sum(pontos["boca_pares_verticais"], []) + list(pontos["boca_cantos"])))
        else:
            self._indices = sorted(set(pontos["olho_esquerdo"] + pontos["olho_direito"]))

    def recortar(self, frame: np.ndarray) -> np.ndarray | None:
        imagem = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        resultado = self._landmarker.detect(imagem)
        if not resultado.face_landmarks:
            return None
        pontos = resultado.face_landmarks[0]
        xs = [pontos[i].x * frame.shape[1] for i in self._indices]
        ys = [pontos[i].y * frame.shape[0] for i in self._indices]
        largura, altura = max(xs) - min(xs), max(ys) - min(ys)
        margem_x, margem_y = max(8, largura * 0.35), max(8, altura * 0.45)
        x0, x1 = max(0, int(min(xs) - margem_x)), min(frame.shape[1], int(max(xs) + margem_x))
        y0, y1 = max(0, int(min(ys) - margem_y)), min(frame.shape[0], int(max(ys) + margem_y))
        return frame[y0:y1, x0:x1]

    def fechar(self) -> None:
        self._landmarker.close()


def salvar_imagem(imagem: np.ndarray, caminho: Path, tamanho: int) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    imagem = cv2.resize(imagem, (tamanho, tamanho), interpolation=cv2.INTER_AREA)
    if not cv2.imwrite(str(caminho), imagem, [cv2.IMWRITE_JPEG_QUALITY, 95]):
        raise OSError(f"Falha ao salvar {caminho}")


def preparar_olhos(linhas, divisao, destino: Path, tamanho: int, input_roi: bool, modelo: Path | None) -> list[dict]:
    recortador = None if input_roi else RecortadorMediaPipe(modelo, "olhos")
    registros = []
    try:
        for indice, linha in enumerate(linhas):
            fonte = Path(linha["image_path"])
            if not fonte.is_file():
                raise FileNotFoundError(f"Imagem nao encontrada: {fonte}")
            imagem = cv2.imread(str(fonte))
            if imagem is None:
                raise ValueError(f"Imagem invalida: {fonte}")
            if recortador:
                imagem = recortador.recortar(imagem)
                if imagem is None:
                    continue
            relativo = Path(divisao[indice]) / linha["label"] / f"{indice:08d}_{fonte.stem}.jpg"
            salvar_imagem(imagem, destino / relativo, tamanho)
            registros.append({"path": relativo.as_posix(), "source": str(fonte), "group_id": linha["grupo"], "label": linha["label"], "split": divisao[indice], "frame": ""})
    finally:
        if recortador:
            recortador.fechar()
    return registros


def preparar_boca(linhas, divisao, destino: Path, tamanho: int, intervalo: int, modelo: Path) -> list[dict]:
    recortador = RecortadorMediaPipe(modelo, "boca")
    registros = []
    try:
        for indice, linha in enumerate(linhas):
            video = Path(linha["video_path"])
            if not video.is_file():
                raise FileNotFoundError(f"Video nao encontrado: {video}")
            cap = cv2.VideoCapture(str(video))
            if not cap.isOpened():
                raise RuntimeError(f"Nao foi possivel abrir o video: {video}")
            frame = 0
            while True:
                ok, imagem = cap.read()
                if not ok:
                    break
                if frame % intervalo == 0:
                    boca = recortador.recortar(imagem)
                    if boca is not None:
                        relativo = Path(divisao[indice]) / linha["label"] / f"{video.stem}_{frame:06d}.jpg"
                        salvar_imagem(boca, destino / relativo, tamanho)
                        registros.append({"path": relativo.as_posix(), "source": str(video), "group_id": linha["grupo"], "label": linha["label"], "split": divisao[indice], "frame": frame})
                frame += 1
            cap.release()
    finally:
        recortador.fechar()
    return registros


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", choices=("olhos", "boca"), required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--input-root", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--mediapipe-model", type=Path)
    parser.add_argument("--input-roi", action="store_true", help="O manifesto de olhos ja aponta para patches CEW")
    parser.add_argument("--frame-stride", type=int, default=5)
    parser.add_argument("--image-size", type=int, default=96)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if args.frame_stride < 1 or args.image_size < 16:
        parser.error("--frame-stride deve ser >= 1 e --image-size >= 16")
    if not args.input_roi and not args.mediapipe_model:
        parser.error("--mediapipe-model e obrigatorio quando a entrada ainda nao e um recorte")
    linhas = ler_manifesto(args.manifest, args.input_root, args.region)
    divisao = dividir_por_grupo(linhas, args.seed)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    registros = preparar_olhos(linhas, divisao, args.output_dir, args.image_size, args.input_roi, args.mediapipe_model) if args.region == "olhos" else preparar_boca(linhas, divisao, args.output_dir, args.image_size, args.frame_stride, args.mediapipe_model)
    with (args.output_dir / "metadata.csv").open("w", newline="", encoding="utf-8") as arquivo:
        escritor = csv.DictWriter(arquivo, fieldnames=["path", "source", "group_id", "label", "split", "frame"])
        escritor.writeheader()
        escritor.writerows(registros)
    print(f"{args.region}: {len(registros)} imagens preparadas em {args.output_dir}")


if __name__ == "__main__":
    main()
