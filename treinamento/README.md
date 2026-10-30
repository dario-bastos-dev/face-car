# Treinamento e avaliação

## Executar localmente

Na raiz do repositório, com as dependências do projeto instaladas:

```bash
uv run python treinamento/preparar_dados.py
uv run python treinamento/treinar.py
uv run python treinamento/avaliar.py
```

Os scripts também podem ser iniciados a partir de outro diretório: cada um localiza
seus dados e resultados em relação ao próprio arquivo. A geração sintética é
reprodutível e cria `dados/dados_sinteticos.csv`. O treino salva o modelo em
`modelos/modelo_sonolencia.joblib` e as previsões em `resultados/previsoes.csv`.
A avaliação usa essas previsões e gera os gráficos em `resultados/`.

Os resultados atuais vêm exclusivamente de dados sintéticos. Eles servem para
verificar o fluxo do programa, não para medir desempenho com motoristas reais.

## Google Colab

Abra `treinamento/treinamento_colab.ipynb` no Colab. A célula de clonagem usa a
branch `feature/treinamento-avaliacao`; ela precisa estar publicada no GitHub para
que essa clonagem funcione. O notebook não baixa datasets. A montagem do Google
Drive é opcional e fica desativada por padrão.

## Formato para dados reais

O treino atual espera um CSV tabular com uma linha por observação rotulada e as
colunas abaixo:

| Coluna | Formato esperado | Significado |
| --- | --- | --- |
| `motorista_id` | identificador estável | Agrupa todas as observações da mesma pessoa |
| `ear` | número | EAR, por exemplo a média dos olhos esquerdo e direito |
| `perclos` | número entre 0 e 1 | Proporção de tempo com os olhos fechados na janela analisada |
| `boca` | número | Métrica de abertura da boca compatível com a usada no treino |
| `sonolento` | 0 ou 1 | Rótulo de referência: alerta ou sonolento |

O extrator existente grava um registro por quadro com `ear_esq`, `ear_dir` e
`abertura_boca`, entre outras métricas, conforme
[`../contratos/metricas.v1.json`](../contratos/metricas.v1.json). Esse CSV não é
diretamente o formato de treino: será necessário definir e documentar uma etapa
de preparação que agrupe os quadros em janelas, calcule `ear` e `perclos` segundo
critérios explícitos e associe rótulos de referência às janelas. `perclos` e
`sonolento` não devem ser inventados a partir de uma extração facial sem
validação e anotação apropriadas.

Mantenha os identificadores de motorista para que a separação de treino e teste
continue sendo feita por pessoa, evitando que quadros do mesmo motorista
apareçam nos dois conjuntos. Documente também a origem dos dados, a licença,
os critérios de anotação e os parâmetros de processamento. UTA-RLDD, NTHU Driver
Drowsiness Detection Dataset e YawDD são possibilidades futuras; obtenha e
prepare esses dados conforme os termos de cada dataset. Não coloque vídeos,
datasets ou CSVs reais no Git: mantenha-os fora do repositório ou sob
`treinamento/dados/reais/`, diretório ignorado pelo `.gitignore`.

A extração de métricas de vídeos reais com MediaPipe será integrada posteriormente
com o módulo de visão. Este projeto não implementa uma extração facial fictícia.
