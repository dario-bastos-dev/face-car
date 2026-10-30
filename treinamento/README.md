# Treinamento CNN do Face-Car

Este módulo classifica imagens faciais em duas classes visuais: `bocejo` e
`sem_bocejo`. Isso não é uma classificação completa de sonolência. O código
usa TensorFlow/Keras e foi estruturado para executar no Google Colab com o
YawDD, sem baixar ou versionar o dataset.

## Preparar o YawDD

Obtenha os vídeos respeitando os termos do dataset e crie um manifesto
supervisionado, por exemplo `manifesto_yawdd.csv`:

```csv
video_path,label,driver_id
person_01/video_001.avi,bocejo,person_01
person_01/video_002.avi,sem_bocejo,person_01
```

Os rótulos devem vir de anotações confiáveis; o script não deduz `bocejo` a
partir do nome do arquivo. O `driver_id` é obrigatório para impedir que frames
do mesmo motorista caiam em treino e teste. O manifesto pode conter caminhos
relativos à opção `--videos-dir`.

```bash
uv run python treinamento/preparar_dados.py \
  --manifest /caminho/manifesto_yawdd.csv \
  --videos-dir /caminho/YawDD \
  --output-dir treinamento/dados/yawdd_processado \
  --frame-stride 5 --image-size 96
```

O script extrai frames com OpenCV, recorta a maior face detectada pelo Haar
cascade, redimensiona para 96×96 e grava `metadata.csv`. A integração futura
com o MediaPipe pode substituir apenas a função de recorte.

## Treinar e avaliar

```bash
uv run python treinamento/treinar.py --data-dir treinamento/dados/yawdd_processado --output-dir treinamento/resultados_cnn
uv run python treinamento/avaliar.py --data-dir treinamento/dados/yawdd_processado --models-dir treinamento/resultados_cnn
```

O Modelo A usa a CNN básica por até 15 épocas. O Modelo B usa data
augmentation, Dropout de 50% e EarlyStopping por até 30 épocas. A avaliação
salva `metricas.json`, matrizes de confusão e `melhor_modelo.keras`, escolhido
pela acurácia de validação. Nenhum resultado é gerado sem treinamento real.

## Google Colab

Abra `treinamento/treinamento_cnn_colab.ipynb`, ative GPU, monte o Drive e
configure o dataset processado em
`/content/drive/MyDrive/Face-Car/datasets/yawdd_processado` e os resultados em
`/content/drive/MyDrive/Face-Car/resultados_cnn`. O notebook não baixa o YawDD.
