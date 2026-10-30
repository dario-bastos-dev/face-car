# CNNs de olhos e boca

Esta etapa treina duas CNNs independentes com imagens reais: olhos `aberto`/
`fechado` e boca `bocejo`/`sem_bocejo`. Não é uma classificação completa de
sonolência e não usa dados sintéticos.

## CEW: olhos

Use os patches de olhos do CEW e crie `manifesto_cew.csv`:

```csv
image_path,label,person_id
eyes/open/0001.jpg,aberto,pessoa_01
eyes/closed/0002.jpg,fechado,pessoa_01
```

Os rótulos devem ser os fornecidos pelo dataset. O `person_id` é obrigatório.
Os patches CEW já são a região dos olhos, por isso não são recortados novamente
com MediaPipe.

```bash
uv run python treinamento/preparar_regioes.py \
  --region olhos --manifest /dados/cew/manifesto_cew.csv \
  --input-root /dados/cew --input-roi \
  --output-dir treinamento/dados/olhos_processado
```

## YawDD: boca

Crie `manifesto_yawdd.csv` com rótulos reais por vídeo ou intervalo:

```csv
video_path,label,driver_id
videos/p01_yawn.avi,bocejo,pessoa_01
videos/p01_normal.avi,sem_bocejo,pessoa_01
```

O script usa o Face Landmarker do MediaPipe para recortar a boca. Não baixe o
modelo automaticamente; coloque `face_landmarker.task` no Drive ou forneça o
caminho local.

```bash
uv run python treinamento/preparar_regioes.py \
  --region boca --manifest /dados/yawdd/manifesto_yawdd.csv \
  --input-root /dados/yawdd --mediapipe-model /dados/face_landmarker.task \
  --output-dir treinamento/dados/boca_processado --frame-stride 5
```

## Treinar e avaliar

```bash
uv run python treinamento/treinar_regioes.py \
  --region olhos --data-dir treinamento/dados/olhos_processado \
  --output-dir treinamento/resultados_cnn/olhos
uv run python treinamento/avaliar_regioes.py \
  --region olhos --data-dir treinamento/dados/olhos_processado \
  --models-dir treinamento/resultados_cnn/olhos
```

Repita trocando `olhos` por `boca`. O Modelo A treina até 15 épocas. O Modelo
B usa augmentation, Dropout e EarlyStopping por até 30 épocas. Cada região
salva modelos `.keras`, métricas e matrizes de confusão.

## Google Colab

Use `treinamento_cnn_colab.ipynb`. Coloque manualmente no Drive:

- `/content/drive/MyDrive/Face-Car/datasets/cew/`
- `/content/drive/MyDrive/Face-Car/datasets/yawdd/`
- `/content/drive/MyDrive/Face-Car/datasets/face_landmarker.task`

Os resultados são salvos em `Face-Car/resultados_cnn/olhos` e
`Face-Car/resultados_cnn/boca`. O notebook não baixa datasets grandes.

## Análise temporal

`analise_temporal.py` prepara PERCLOS, eventos de piscada, abertura da boca,
velocidade do `pitch` e recuperação da cabeça. A decisão temporal será
implementada depois das CNNs, usando as métricas do MediaPipe e confirmação de
eventos ao longo de janelas, para evitar alertas por movimentos normais.
## Resultados do treinamento e avaliação

Foram treinadas duas CNNs para cada região, utilizando TensorFlow/Keras e imagens de 96 × 96 pixels.

| Região | CNN A | CNN B |
|---|---:|---:|
| Olhos | 92,43% | **97,37%** |
| Boca | 94,21% | **96,71%** |

*Valores de acurácia no conjunto de teste.*

### Dados utilizados

- **Olhos:** 4.000 imagens; 1.637 utilizadas no teste.
- **Boca:** 5.119 imagens originais, reduzidas para 4.400 após remoção de duplicatas e conflitos; 881 utilizadas no teste.

A CNN B apresentou maior acurácia no teste em ambas as regiões. Nos olhos, a CNN A apresentou melhor desempenho na validação, portanto a escolha posterior da CNN B deve ser considerada uma decisão exploratória.

A divisão dos dados da boca foi feita por imagem, sem garantia de independência entre participantes. Os resultados ainda precisam ser confirmados em condições reais com webcam.

### Modelos treinados

Os arquivos estão disponíveis no Google Drive, na pasta `Face-Car/entrega_modelos`:

- `cnn_olhos.keras`
- `cnn_boca.keras`

Ambos foram carregados com sucesso no TensorFlow.

**Entrada:** `(None, 96, 96, 3)`

**Saída:** `(None, 2)`

Os modelos serão utilizados pela equipe na integração com o MediaPipe.
