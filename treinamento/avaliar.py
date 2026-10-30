"""Avalia os dois modelos CNN e salva metricas, graficos e o melhor modelo."""
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


def dataset(pasta: Path, split: str, tamanho: int, batch_size: int) -> tf.data.Dataset:
    return keras.utils.image_dataset_from_directory(pasta / split, labels="inferred", label_mode="int",
        class_names=["bocejo", "sem_bocejo"], image_size=(tamanho, tamanho), batch_size=batch_size,
        shuffle=False).prefetch(tf.data.AUTOTUNE)


def prever(modelo: keras.Model, dados: tf.data.Dataset) -> tuple[np.ndarray, np.ndarray]:
    reais = np.concatenate([y.numpy() for _, y in dados])
    previstas = np.argmax(modelo.predict(dados, verbose=0), axis=1)
    return reais, previstas


def metricas(reais: np.ndarray, previstas: np.ndarray) -> dict[str, float]:
    return {"acuracia": float(accuracy_score(reais, previstas)), "precisao": float(precision_score(reais, previstas, zero_division=0)),
            "recall": float(recall_score(reais, previstas, zero_division=0)), "f1": float(f1_score(reais, previstas, zero_division=0))}


def plotar_historicos(pasta: Path) -> None:
    fig, eixos = plt.subplots(1, 2, figsize=(12, 4))
    for nome in ("a", "b"):
        caminho = pasta / f"historico_{nome}.json"
        if not caminho.is_file():
            continue
        historico = json.loads(caminho.read_text(encoding="utf-8"))
        eixos[0].plot(historico.get("accuracy", []), label=f"A - treino" if nome == "a" else "B - treino")
        eixos[0].plot(historico.get("val_accuracy", []), linestyle="--", label=f"A - validação" if nome == "a" else "B - validação")
        eixos[1].plot(historico.get("loss", []), label=f"A - treino" if nome == "a" else "B - treino")
        eixos[1].plot(historico.get("val_loss", []), linestyle="--", label=f"A - validação" if nome == "a" else "B - validação")
    eixos[0].set_title("Acurácia por época"); eixos[0].set_xlabel("época"); eixos[0].legend(); eixos[0].grid(alpha=.3)
    eixos[1].set_title("Perda por época"); eixos[1].set_xlabel("época"); eixos[1].legend(); eixos[1].grid(alpha=.3)
    plt.tight_layout(); plt.savefig(pasta / "curvas_treinamento.png", dpi=150); plt.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "dados" / "yawdd_processado")
    parser.add_argument("--models-dir", type=Path, default=Path(__file__).parent / "resultados_cnn")
    parser.add_argument("--image-size", type=int, default=96)
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()
    args.models_dir.mkdir(parents=True, exist_ok=True)
    validacao, teste = dataset(args.data_dir, "validacao", args.image_size, args.batch_size), dataset(args.data_dir, "teste", args.image_size, args.batch_size)
    resumo, melhor_nome, melhor_val = {}, None, -1.0
    for nome in ("a", "b"):
        caminho = args.models_dir / f"modelo_{nome}.keras"
        if not caminho.is_file():
            raise FileNotFoundError(f"Modelo ausente: {caminho}. Execute treinar.py primeiro.")
        modelo = keras.models.load_model(caminho)
        val_reais, val_previstas = prever(modelo, validacao)
        test_reais, test_previstas = prever(modelo, teste)
        val, test = metricas(val_reais, val_previstas), metricas(test_reais, test_previstas)
        resumo[nome] = {"validacao": val, "teste": test, "relatorio_teste": classification_report(test_reais, test_previstas, target_names=["bocejo", "sem_bocejo"], output_dict=True, zero_division=0)}
        if val["acuracia"] > melhor_val:
            melhor_nome, melhor_val = nome, val["acuracia"]
        matriz = confusion_matrix(test_reais, test_previstas, labels=[0, 1])
        ConfusionMatrixDisplay(matriz, display_labels=["bocejo", "sem_bocejo"]).plot(cmap="Blues", values_format="d")
        plt.title(f"Modelo {nome.upper()} - teste"); plt.tight_layout(); plt.savefig(args.models_dir / f"matriz_confusao_{nome}.png", dpi=150); plt.close()
    shutil.copy2(args.models_dir / f"modelo_{melhor_nome}.keras", args.models_dir / "melhor_modelo.keras")
    (args.models_dir / "metricas.json").write_text(json.dumps(resumo, ensure_ascii=False, indent=2), encoding="utf-8")
    plotar_historicos(args.models_dir)
    nomes = ["A", "B"]
    fig, ax = plt.subplots(figsize=(8, 4))
    x = np.arange(len(nomes)); largura = 0.2
    for deslocamento, chave in enumerate(("acuracia", "precisao", "recall", "f1")):
        valores = [resumo[n.lower()]["teste"][chave] for n in nomes]
        ax.bar(x + (deslocamento - 1.5) * largura, valores, largura, label=chave)
    ax.set_xticks(x, nomes); ax.set_ylim(0, 1); ax.set_ylabel("valor"); ax.set_title("Comparação no teste"); ax.legend(); ax.grid(axis="y", alpha=.3)
    plt.tight_layout(); plt.savefig(args.models_dir / "comparacao_modelos.png", dpi=150); plt.close()
    print(json.dumps({"melhor_modelo": melhor_nome, "acuracia_validacao": melhor_val, "metricas": resumo}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
