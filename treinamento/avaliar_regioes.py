"""Avalia CNNs A/B de olhos ou boca sem inventar resultados."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from sklearn.metrics import ConfusionMatrixDisplay, accuracy_score, classification_report, confusion_matrix, f1_score, precision_score, recall_score
import tensorflow as tf
from tensorflow import keras

CLASSES = {"olhos": ["aberto", "fechado"], "boca": ["bocejo", "sem_bocejo"]}


def carregar(pasta: Path, split: str, classes: list[str], tamanho: int, lote: int) -> tf.data.Dataset:
    return keras.utils.image_dataset_from_directory(pasta / split, labels="inferred", label_mode="int", class_names=classes, image_size=(tamanho, tamanho), batch_size=lote, shuffle=False).prefetch(tf.data.AUTOTUNE)


def avaliar_modelo(modelo, dados) -> tuple[np.ndarray, np.ndarray]:
    reais = np.concatenate([rotulos.numpy() for _, rotulos in dados])
    previstos = np.argmax(modelo.predict(dados, verbose=0), axis=1)
    return reais, previstos


def resumo(reais, previstos) -> dict[str, float]:
    return {"acuracia": float(accuracy_score(reais, previstos)), "precisao": float(precision_score(reais, previstos, zero_division=0)), "recall": float(recall_score(reais, previstos, zero_division=0)), "f1": float(f1_score(reais, previstos, zero_division=0))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", choices=CLASSES, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--image-size", type=int, default=96)
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()
    args.models_dir.mkdir(parents=True, exist_ok=True)
    classes = CLASSES[args.region]
    validacao = carregar(args.data_dir, "validacao", classes, args.image_size, args.batch_size)
    teste = carregar(args.data_dir, "teste", classes, args.image_size, args.batch_size)
    resultados, melhor, melhor_val = {}, None, -1.0
    for nome in ("a", "b"):
        modelo = keras.models.load_model(args.models_dir / f"modelo_{nome}.keras")
        val_real, val_prev = avaliar_modelo(modelo, validacao)
        teste_real, teste_prev = avaliar_modelo(modelo, teste)
        resultados[nome] = {"validacao": resumo(val_real, val_prev), "teste": resumo(teste_real, teste_prev), "relatorio_teste": classification_report(teste_real, teste_prev, target_names=classes, output_dict=True, zero_division=0)}
        if resultados[nome]["validacao"]["acuracia"] > melhor_val:
            melhor, melhor_val = nome, resultados[nome]["validacao"]["acuracia"]
        ConfusionMatrixDisplay(confusion_matrix(teste_real, teste_prev, labels=list(range(len(classes)))), display_labels=classes).plot(cmap="Blues", values_format="d")
        plt.title(f"{args.region} - modelo {nome.upper()} - teste"); plt.tight_layout(); plt.savefig(args.models_dir / f"matriz_confusao_{nome}.png", dpi=150); plt.close()
    shutil.copy2(args.models_dir / f"modelo_{melhor}.keras", args.models_dir / "melhor_modelo.keras")
    (args.models_dir / "metricas.json").write_text(json.dumps(resultados, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"region": args.region, "melhor_modelo": melhor, "metricas": resultados}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
