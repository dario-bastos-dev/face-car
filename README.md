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
uv run python -m entrada webcam --rotulo alerta --pessoa p01                        # pergunta a câmera
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
| `--mostrar` | ligado na webcam, desligado no vídeo | janela por câmera com o mapeamento; o quadrado pisca em verde a cada captura |
| `--sem-janela` | — | webcam: capturar sem abrir a janela |
| `--sem-modelo` | — | não enviar as capturas para o modelo |
| `--limite-fotos` | 100 | máximo de fotos guardadas; ao chegar nele, a mais antiga é apagada |

Os arquivos ficam em `<saida>/<camera>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg`. Uma pasta por classe é o formato que as bibliotecas de treino
de imagens leem direto, e a pessoa no nome permite separar treino e teste por pessoa, para o
modelo não decorar rostos. As câmeras usam o mesmo relógio, então o `t_ms` de uma captura na
`rgb` e na `ir` se comparam.

### Limite de fotos

A pasta de saída guarda no máximo 100 fotos (`captura.limite_fotos`), somando câmeras e rótulos.
Ao chegar no limite, a foto mais antiga (pela data do arquivo, inclusive de sessões anteriores) é
apagada antes de gravar a nova; o fim da captura informa quantas foram apagadas. Só entram na conta,
e só podem ser apagados, arquivos em `<camera>/<rotulo>/` com o nome que a captura gera: qualquer
outro arquivo na pasta fica intocado.

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

## Resultado do modelo

A cada captura, o **quadro inteiro** da câmera vai para o modelo `cnn_sonolencia.keras` (na raiz do
projeto, fora do git por ser grande) e o resultado aparece no terminal e no painel da janela:

```
[rgb    5,7 s] alerta 99,9%  (sonolento 0,1%)
[rgb    6,7 s] sonolento 87,2%  (alerta 12,8%)
```

O modelo foi treinado com o quadro inteiro em RGB, redimensionado para 96×96, com os pixels de 0 a 255
(a normalização é uma camada dele); a captura prepara a imagem do mesmo jeito, antes de qualquer
desenho na janela. As saídas são, na ordem, `sonolento` e `alerta` (`classificador.classes` em
`config/captura.json`). Sem o arquivo, a captura avisa e segue sem classificar; `--sem-modelo`
desliga a classificação. A câmera infravermelha entrega imagens em cinza, diferentes das coloridas
do treino, então o resultado dela tende a valer pouco.

## Mapeamento na janela

Na webcam a janela abre sempre (use `--sem-janela` para capturar sem ela); no vídeo, só com
`--mostrar`. Sem tela gráfica, como por SSH, a captura segue sem janela e avisa. Cada janela
desenha sobre a imagem:

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
entrada/         fontes de vídeo, detector, recortes, mapeamento, classificador, gravação, linha de comando
scripts/         preparação do modelo e do vídeo de teste
testes/          testes (entrada/) e dados gerados pelo preparar.sh (dados/)
```
