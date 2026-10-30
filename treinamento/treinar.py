"""Treina os modelos A e B com imagens reais previamente preparadas."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import tensorflow as tf
from tensorflow import keras

from cnn_modelos import construir_cnn


def carregar_dataset(pasta: Path, split: str, tamanho: int, batch_size: int) -> tf.data.Dataset:
    raiz = pasta / split
    if not raiz.is_dir():
        raise FileNotFoundError(f"Pasta ausente: {raiz}. Execute preparar_dados.py primeiro.")
    return keras.utils.image_dataset_from_directory(raiz, labels="inferred", label_mode="int",
        class_names=["bocejo", "sem_bocejo"], image_size=(tamanho, tamanho), batch_size=batch_size,
        shuffle=(split == "treino"), seed=42).prefetch(tf.data.AUTOTUNE)


def treinar(nome: str, modelo: keras.Model, treino: tf.data.Dataset, validacao: tf.data.Dataset,
            epocas: int, callbacks: list, saida: Path) -> None:
    historico = modelo.fit(treino, validation_data=validacao, epochs=epocas, callbacks=callbacks, verbose=2)
    modelo.save(saida / f"modelo_{nome}.keras")
    (saida / f"historico_{nome}.json").write_text(json.dumps(historico.history, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "dados" / "yawdd_processado")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "resultados_cnn")
    parser.add_argument("--image-size", type=int, default=96)
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    tf.random.set_seed(42)
    print("TensorFlow:", tf.__version__, "| GPU disponivel:", bool(tf.config.list_physical_devices("GPU")))
    treino = carregar_dataset(args.data_dir, "treino", args.image_size, args.batch_size)
    validacao = carregar_dataset(args.data_dir, "validacao", args.image_size, args.batch_size)
    treinar("a", construir_cnn(args.image_size, 2, 0.0, False), treino, validacao, 15, [], args.output_dir)
    parar_cedo = [keras.callbacks.EarlyStopping(monitor="val_loss", patience=4, restore_best_weights=True)]
    treinar("b", construir_cnn(args.image_size, 2, 0.5, True), treino, validacao, 30, parar_cedo, args.output_dir)
    print(f"Modelos e historicos salvos em: {args.output_dir}")


if __name__ == "__main__":
    main()

