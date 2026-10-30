
from pathlib import Path
import pandas as pd
import joblib

from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (
    accuracy_score,
    recall_score,
    confusion_matrix,
    classification_report
)

# Pastas do projeto
BASE = Path(__file__).parent
DADOS = BASE / "dados" / "dados_sinteticos.csv"
MODELOS = BASE / "modelos"
RESULTADOS = BASE / "resultados"

MODELOS.mkdir(exist_ok=True)
RESULTADOS.mkdir(exist_ok=True)

# 1. Carregar o CSV
df = pd.read_csv(DADOS)

X = df[["ear", "perclos", "boca"]]
y = df["sonolento"]

# 2. Separar os motoristas para treino e teste
divisao = GroupShuffleSplit(
    n_splits=1,
    test_size=0.25,
    random_state=42
)

treino, teste = next(
    divisao.split(X, y, groups=df["motorista_id"])
)

X_treino = X.iloc[treino]
X_teste = X.iloc[teste]
y_treino = y.iloc[treino]
y_teste = y.iloc[teste]

# 3. Treinar o modelo
modelo = make_pipeline(
    StandardScaler(),
    LogisticRegression(max_iter=1000)
)

modelo.fit(X_treino, y_treino)

# 4. Fazer previsões
previsoes = modelo.predict(X_teste)

# 5. Mostrar os resultados
print("\n=== RESULTADOS DA IA ===")
print("Acurácia:", accuracy_score(y_teste, previsoes))
print("Sensibilidade:", recall_score(
    y_teste, previsoes, zero_division=0
))

print("\nRelatório completo:")
print(classification_report(
    y_teste, previsoes, zero_division=0
))

print("Matriz de confusão:")
print(confusion_matrix(y_teste, previsoes))

# 6. Salvar modelo
arquivo_modelo = MODELOS / "modelo_sonolencia.joblib"
joblib.dump(modelo, arquivo_modelo)

# 7. Salvar previsões
resultado = X_teste.copy()
resultado["motorista_id"] = df.iloc[teste]["motorista_id"].values
resultado["real"] = y_teste.values
resultado["previsto"] = previsoes

resultado.to_csv(
    RESULTADOS / "previsoes.csv",
    index=False
)

print("\nModelo salvo em:", arquivo_modelo)
print("Previsões salvas em resultados/previsoes.csv")
