"""Exporta o modelo treinado para JSON, para o simulador aplicá-lo no navegador.

Lê treinamento/modelos/modelo_sonolencia.joblib (gerado por treinar.py: StandardScaler +
LogisticRegression) e grava modelos/modelo_sonolencia.json, lido por simulador/js/modelo.js.

    uv run python treinamento/exportar_modelo.py
"""
import json
from pathlib import Path

import joblib

BASE = Path(__file__).parent
ENTRADA = BASE / "modelos" / "modelo_sonolencia.joblib"
SAIDA = BASE.parent / "modelos" / "modelo_sonolencia.json"
ATRIBUTOS = ["ear", "perclos", "boca"]  # mesma ordem de X em treinar.py

modelo = joblib.load(ENTRADA)
escalador = modelo.named_steps["standardscaler"]
regressao = modelo.named_steps["logisticregression"]
if list(getattr(escalador, "feature_names_in_", ATRIBUTOS)) != ATRIBUTOS:
    raise SystemExit(f"Atributos inesperados no modelo: {list(escalador.feature_names_in_)}")

exportado = {
    "versao": 1,
    "tipo": "regressao_logistica",
    "atributos": ATRIBUTOS,
    "media": escalador.mean_.tolist(),
    "escala": escalador.scale_.tolist(),
    "coeficientes": regressao.coef_[0].tolist(),
    "intercepto": float(regressao.intercept_[0]),
    "origem": "treinamento/treinar.py",
    "aviso": "Treinado com dados sintéticos: serve para validar o fluxo, não para uso real.",
}
SAIDA.parent.mkdir(exist_ok=True)
SAIDA.write_text(json.dumps(exportado, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Modelo exportado para {SAIDA}")
