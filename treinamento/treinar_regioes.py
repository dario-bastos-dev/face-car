"""Treina CNNs A/B separadamente para olhos ou boca."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import tensorflow as tf
from tensorflow import keras

from cnn_modelos import construir_cnn

CLASSES = {"olhos": ["aberto", "fechado"], "boca": ["bocejo", "sem_bocejo"]}


def carregar(pasta: Path, split: str, classes: list[str], tamanho: int, lote: int) -> tf.data.Dataset:
    raiz = pasta / split
    if not raiz.is_dir():
        raise FileNotFoundError(f"Pasta ausente: {raiz}")
    return keras.utils.image_dataset_from_directory(raiz, labels="inferred", label_mode="int", class_names=classes, image_size=(tamanho, tamanho), batch_size=lote, shuffle=split == "treino", seed=42).prefetch(tf.data.AUTOTUNE)


def treinar(nome: str, modelo, treino, validacao, epocas: int, callbacks: list, destino: Path) -> None:
    historico = modelo.fit(treino, validation_data=validacao, epochs=epocas, callbacks=callbacks, verbose=2)
    modelo.save(destino / f"modelo_{nome}.keras")
    (destino / f"historico_{nome}.json").write_text(json.dumps(historico.history, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", choices=CLASSES, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--image-size", type=int, default=96)
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    tf.random.set_seed(42)
    classes = CLASSES[args.region]
    treino = carregar(args.data_dir, "treino", classes, args.image_size, args.batch_size)
    validacao = carregar(args.data_dir, "validacao", classes, args.image_size, args.batch_size)
    treinar("a", construir_cnn(args.image_size, len(classes), 0.0, False), treino, validacao, 15, [], args.output_dir)
    callback = [keras.callbacks.EarlyStopping(monitor="val_loss", patience=4, restore_best_weights=True)]
    treinar("b", construir_cnn(args.image_size, len(classes), 0.5, True), treino, validacao, 30, callback, args.output_dir)
    print(f"CNN {args.region} salva em {args.output_dir}")


if __name__ == "__main__":
    main()
