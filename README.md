# Captura do rosto do motorista

Lê as webcams (a colorida e a infravermelha) ou um vídeo, encontra o rosto com o MediaPipe Face
Landmarker e grava, a cada intervalo fixo, um recorte do **rosto completo** (224×224 px, JPEG).
Os recortes formam o conjunto de dados para treinar, neste computador, um modelo de imagens
que classifica o estado do motorista.

## Preparar

```bash
uv sync                      # Python 3.12, mediapipe, opencv-contrib-python, numpy, pytest
./scripts/preparar.sh        # baixa o modelo e gera o vídeo de teste (precisa de ffmpeg)
```

## Capturar

```bash
uv run python -m entrada webcam --rotulo alerta --pessoa p01 --mostrar               # pergunta a câmera
uv run python -m entrada webcam --camera ir --rotulo alerta --pessoa p01             # só a infravermelha
uv run python -m entrada webcam --camera todas --rotulo alerta --pessoa p01          # as duas
uv run python -m entrada video <seu-video.mp4> --rotulo sonolento --pessoa p07       # vídeo gravado
```

| Opção | Padrão | Efeito |
| --- | --- | --- |
| `--rotulo` | `sem_rotulo` | classe das imagens; vira a pasta |
| `--pessoa` | `anonimo` | identificador da pessoa; vai no nome do arquivo |
| `--camera` | menu (webcam), `rgb` (vídeo) | webcam: `rgb`, `ir` ou `todas` (repetível); vídeo: nome da pasta |
| `--intervalo-ms` | 1000 | tempo mínimo entre duas capturas |
| `--saida` | `saidas/imagens` | pasta raiz dos recortes |
| `--segundos` | sem limite | webcam: parar depois deste tempo |
| `--mostrar` | desligado | uma janela por câmera com o quadrado do rosto; pisca em verde a cada captura |

Os arquivos ficam em `<saida>/<camera>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg`. Uma pasta por classe é o formato que as bibliotecas de treino
de imagens leem direto, e a pessoa no nome permite separar treino e teste por pessoa, para o
modelo não decorar rostos. As câmeras usam o mesmo relógio, então o `t_ms` de uma captura na
`rgb` e na `ir` se comparam.

## Câmeras

Sem `--camera`, o comando `webcam` mostra um menu com as câmeras configuradas e a opção `todas`;
responda com o número ou o nome, ou Enter para a padrão (`camera_padrao`, hoje `rgb`). Fora de um
terminal interativo, ele usa a padrão sem perguntar.

As câmeras ficam em `config/captura.json` pelo caminho fixo em `/dev/v4l/by-path/`, e não pelo
número (`/dev/video0`, `/dev/video2`), que pode mudar ao reiniciar ou reconectar. Em outro
computador, veja os caminhos com `ls -l /dev/v4l/by-path/` e `v4l2-ctl --list-devices`.

| Nome | Câmera | Imagem |
| --- | --- | --- |
| `rgb` | HD Webcam | colorida, 640×480 |
| `ir` | IR Camera | infravermelha em tons de cinza, 640×360 |

## Como os recortes são feitos

- O MediaPipe procura até 3 rostos e só o **maior** é recortado: o do motorista, mais perto da
  câmera. Pessoas ao fundo não entram no conjunto de dados.
- O recorte é um quadrado centrado no rosto, com lado 1,5 vez o maior eixo dele
  (`recorte.margem = 0.25`), para incluir testa, queixo e a inclinação da cabeça. Perto da borda,
  a parte fora da imagem é preenchida de preto, e o rosto continua centrado.
- Quadros sem rosto não geram imagem e não consomem a vez: a captura acontece no primeiro quadro
  com rosto depois que o intervalo passou.

## Mapeamento na janela

Com `--mostrar`, cada janela desenha sobre a imagem:

- o contorno do **rosto** (azul) e o quadrado que vira recorte (amarelo; verde a cada captura);
- o contorno dos **olhos** e dos **lábios** (verde) e as **íris** (rosa);
- a direção da **cabeça**: seta amarela saindo do nariz, vinda da matriz de pose do MediaPipe;
- a direção do **olhar**: setas rosa saindo das íris, pela posição da íris entre os cantos do olho,
  medida ao longo do eixo do olho para não confundir cabeça inclinada com olhar para cima;
- no painel, para onde a cabeça e o olhar apontam (`frente`, `esquerda`, `baixo e direita`…), do
  ponto de vista do motorista: como a câmera não espelha a imagem, olhar para a esquerda dele
  leva o rosto para a direita da imagem. Os limiares (15° para a cabeça e 0,2 da meia largura do
  olho para a íris) ficam em `entrada/mapa.py`.

O mapeamento só aparece na tela: o recorte gravado para o modelo sai do quadro antes do desenho
e não tem marcas.

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
config/          parâmetros da captura e das câmeras
entrada/         fontes de vídeo, detector, recortes, mapeamento, agendamento e gravação, linha de comando
scripts/         preparação do modelo e do vídeo de teste
testes/          testes (entrada/) e dados gerados pelo preparar.sh (dados/)
```
