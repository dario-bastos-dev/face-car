#!/usr/bin/env bash
# Roda treinamento/modelo.ipynb inteiro fora do editor: fechar o VS Code não interrompe o treino.
# Sem GPU leva de 1 a 2 horas. No fim, o modelo vai para modelo/ (o anterior, para
# modelo/anteriores/) e o notebook executado, com gráficos e relatório, para treinamento/resultados/.
#
#   nohup treinamento/treinar.sh > treinamento/resultados/treinar.log 2>&1 &
#   tail -f treinamento/resultados/treino_fase1.csv     # uma linha por época (depois, fase2)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p treinamento/resultados
uv run jupyter nbconvert --to notebook --execute treinamento/modelo.ipynb \
    --ExecutePreprocessor.timeout=-1 --ExecutePreprocessor.kernel_name=python3 \
    --output-dir treinamento/resultados --output "modelo_executado_$(date +%Y-%m-%d_%H%M)"
