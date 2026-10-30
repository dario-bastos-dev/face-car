
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.metrics import (
    confusion_matrix,
    ConfusionMatrixDisplay,
    accuracy_score,
    recall_score,
    precision_score,
    f1_score
)

BASE = Path(__file__).parent
RESULTADOS = BASE / "resultados"
RESULTADOS.mkdir(exist_ok=True)

# Carregar previsoes do modelo
df = pd.read_csv(RESULTADOS / "previsoes.csv")

real = df["real"]
previsto = df["previsto"]

# Calcular metricas
metricas = {
    "Acuracia": accuracy_score(real, previsto),
    "Precisao": precision_score(real, previsto, zero_division=0),
    "Sensibilidade": recall_score(real, previsto, zero_division=0),
    "F1-score": f1_score(real, previsto, zero_division=0)
}

# Grafico 1 - Comparacao das metricas
plt.figure(figsize=(9, 5))
barras = plt.bar(
    metricas.keys(),
    [v * 100 for v in metricas.values()]
)

plt.ylim(0, 110)
plt.ylabel("Porcentagem (%)")
plt.title("Avaliacao da IA - Dados Sinteticos")

for barra in barras:
    altura = barra.get_height()
    plt.text(
        barra.get_x() + barra.get_width() / 2,
        altura + 2,
        f"{altura:.1f}%",
        ha="center"
    )

plt.tight_layout()
plt.savefig(
    RESULTADOS / "metricas.png",
    dpi=150
)
plt.close()

# Grafico 2 - Matriz de confusao
matriz = confusion_matrix(real, previsto, labels=[0, 1])

visualizacao = ConfusionMatrixDisplay(
    confusion_matrix=matriz,
    display_labels=["Alerta", "Sonolento"]
)

visualizacao.plot(cmap="Blues", values_format="d")
plt.title("Matriz de Confusao - Dados Sinteticos")
plt.tight_layout()
plt.savefig(
    RESULTADOS / "matriz_confusao.png",
    dpi=150
)
plt.close()

print("AVALIACAO CONCLUIDA!")
print("\nMetricas:")

for nome, valor in metricas.items():
    print(f"{nome}: {valor:.2%}")

print("\nGraficos salvos em:")
print(RESULTADOS / "metricas.png")
print(RESULTADOS / "matriz_confusao.png")
