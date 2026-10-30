
from pathlib import Path
import numpy as np
import pandas as pd

# Local onde o CSV será salvo
pasta = Path(__file__).parent / "dados"
pasta.mkdir(exist_ok=True)

# Gerador de dados reproduzíveis
rng = np.random.default_rng(42)

dados = []

# Simular 40 motoristas
for motorista in range(40):

    # Metade dos motoristas alertas e metade sonolentos
    sonolento = motorista >= 20

    for _ in range(20):

        if sonolento:
            ear = rng.normal(0.16, 0.035)
            perclos = rng.normal(0.65, 0.15)
            boca = rng.normal(0.55, 0.15)
        else:
            ear = rng.normal(0.30, 0.035)
            perclos = rng.normal(0.10, 0.08)
            boca = rng.normal(0.20, 0.10)

        dados.append({
            "motorista_id": motorista,
            "ear": round(float(np.clip(ear, 0, 1)), 4),
            "perclos": round(float(np.clip(perclos, 0, 1)), 4),
            "boca": round(float(np.clip(boca, 0, 1)), 4),
            "sonolento": int(sonolento)
        })

# Criar a tabela
df = pd.DataFrame(dados)

# Salvar em CSV
arquivo = pasta / "dados_sinteticos.csv"
df.to_csv(arquivo, index=False)

print("DADOS GERADOS COM SUCESSO!")
print("Total de amostras:", len(df))
print("Arquivo salvo em:", arquivo)
print(df.head())
