# Captura do rosto do motorista

Lê um vídeo ou a webcam, encontra o rosto com o MediaPipe Face Landmarker e grava, a cada
intervalo fixo, um recorte quadrado só do rosto (224×224 px, JPEG). Os recortes formam o
conjunto de dados para treinar, neste computador, um modelo de imagens que classifica o
estado do motorista.

## Preparar

```bash
uv sync                      # Python 3.12, mediapipe, opencv-contrib-python, numpy, pytest
./scripts/preparar.sh        # baixa o modelo e gera o vídeo de teste (precisa de ffmpeg)
```

## Capturar

```bash
uv run python -m entrada video testes/dados/retrato.mp4 --rotulo alerta --pessoa p01 --mostrar
uv run python -m entrada video <seu-video.mp4> --rotulo sonolento --pessoa p07
uv run python -m entrada webcam --rotulo alerta --pessoa p01 --mostrar [--segundos 60]
```

| Opção | Padrão | Efeito |
| --- | --- | --- |
| `--rotulo` | `sem_rotulo` | classe das imagens; vira a pasta |
| `--pessoa` | `anonimo` | identificador da pessoa; vai no nome do arquivo |
| `--intervalo-ms` | 1000 | tempo mínimo entre duas capturas |
| `--saida` | `saidas/imagens` | pasta raiz dos recortes |
| `--mostrar` | desligado | janela com o quadrado do recorte; pisca em verde a cada captura |

Os arquivos ficam em `<saida>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg`. Uma pasta por classe é o
formato que as bibliotecas de treino de imagens leem direto, e a pessoa no nome permite separar
treino e teste por pessoa, para o modelo não decorar rostos.

## Como o recorte é feito

- O MediaPipe procura até 3 rostos e só o **maior** é recortado: o do motorista, mais perto da
  câmera. Pessoas ao fundo não entram no conjunto de dados.
- O quadrado é centrado no rosto, com lado 1,5 vez o maior eixo dele (`recorte.margem = 0.25`),
  para incluir testa, queixo e a inclinação da cabeça. Perto da borda, a parte que fica fora da
  imagem é preenchida de preto, e o rosto continua centrado.
- Quadros sem rosto não geram imagem e não consomem a vez: a captura acontece no primeiro quadro
  com rosto depois que o intervalo passou.

Limiares, margem, tamanho, qualidade do JPEG e intervalo ficam em `config/captura.json`.

## Privacidade

Os recortes são dados pessoais (LGPD). Eles ficam só neste computador: `saidas/` está no
`.gitignore` e nunca vai para o repositório. Grave apenas pessoas que concordaram, e não induza
sono ou embriaguez reais para gerar dados.

## Testes

```bash
uv run pytest                # os testes com MediaPipe precisam de ./scripts/preparar.sh antes
```

## Estrutura

```
config/          parâmetros da captura
entrada/         fontes de vídeo, detector, recorte, agendamento e gravação, linha de comando
scripts/         preparação do modelo e do vídeo de teste
testes/          testes (entrada/) e dados gerados pelo preparar.sh (dados/)
```
