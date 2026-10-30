"""Arquiteturas CNN do Face-Car, baseadas na Aula 10 do professor."""
from __future__ import annotations

from tensorflow import keras
from tensorflow.keras import layers


def construir_cnn(image_size: int = 96, classes: int = 2, dropout: float = 0.0, aumentar: bool = False) -> keras.Model:
    camadas: list = [keras.Input(shape=(image_size, image_size, 3))]
    if aumentar:
        camadas += [layers.RandomFlip("horizontal"), layers.RandomRotation(0.05), layers.RandomZoom(0.10)]
    camadas += [layers.Rescaling(1 / 255.0), layers.Conv2D(32, 3, padding="same", activation="relu"),
                layers.Conv2D(32, 3, padding="same", activation="relu"), layers.MaxPooling2D(),
                layers.Conv2D(64, 3, padding="same", activation="relu"), layers.Conv2D(64, 3, padding="same", activation="relu"),
                layers.MaxPooling2D(), layers.Flatten(), layers.Dense(256, activation="relu"),
                layers.Dense(classes, activation="softmax")]
    if dropout > 0:
        camadas.insert(-1, layers.Dropout(dropout))
    modelo = keras.Sequential(camadas)
    modelo.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    return modelo

