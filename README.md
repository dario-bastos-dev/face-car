# Face-Car · Visão, estimador e política de ação

## Parte 3 · Simulador e integração

Simulador de direção (visão 2D e cabine 3D) com o **scanner de rosto** real: a webcam passa
pelo extrator da Parte 1 e pelo estimador da Parte 2 na própria página, e as mensagens
`sinal.v1` comandam o veículo simulado. Também recebe o estimador em Python por WebSocket e
reproduz mensagens gravadas.

```bash
python simulador/servidor.py     # http://localhost:8000/simulador/  (WebSocket: pip install websockets)
node --test testes/js/receptor.test.mjs
```

No cartão da câmera, **◉ Demonstrar** liga o scanner mostrando a malha do rosto e
**◌ Invisível** mantém o scanner rodando sem desenho. Veja o [guia da Parte 3](docs/parte3.md).

## Parte 2 pronta para executar sem câmera

A Parte 2 consome o CSV da visão, estima PERCLOS, índice e confiança e aplica
uma máquina de estados configurável. Produz ações e heartbeat com `seq`, `ts`
e `ttl`, inclui calibração opcional avaliada em dados separados e módulos
equivalentes em Python e JavaScript.

```bash
uv sync
uv run python -m estimador replay exemplos/parte2/metricas.csv -o saidas/sinais.jsonl --diagnostico saidas/diagnostico.jsonl
uv run pytest testes/estimador
npm run test:estimador
```

Leia o [guia completo da Parte 2](docs/parte2.md) para instalação mínima no
Windows, fórmulas, estados, contrato e integração com a Parte 3. Os exemplos
são sintéticos e os parâmetros são experimentais para simulação.

## Parte 1 · Visão

A visão usa o MediaPipe Face Landmarker de duas formas, que convivem:

- **Captura do rosto com o modelo de imagens:** grava recortes do rosto e classifica cada
  captura com `cnn_sonolencia.keras` (`python -m entrada webcam|video`).
- **Métricas faciais em CSV:** uma linha por quadro no contrato `metricas.v1`, que alimenta o
  estimador da Parte 2 e o simulador da Parte 3 (`python -m entrada metricas webcam|video`).

### Preparar
```bash
uv sync                      # Python 3.12, mediapipe, opencv-contrib-python, numpy, pytest
./scripts/preparar.sh        # baixa o modelo e gera os vídeos de teste (precisa de ffmpeg)
```

### Captura do rosto e modelo de imagens

Lê as webcams (a colorida e a infravermelha) ou um vídeo, encontra o rosto com o MediaPipe Face
Landmarker e grava, a cada intervalo fixo, um recorte do **rosto completo** (224×224 px, JPEG).
Os recortes formam o conjunto de dados para treinar, neste computador, um modelo de imagens
que classifica o estado do motorista.

#### Capturar

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

##### Limite de fotos

A pasta de saída guarda no máximo 100 fotos (`captura.limite_fotos`), somando câmeras e rótulos.
Ao chegar no limite, a foto mais antiga (pela data do arquivo, inclusive de sessões anteriores) é
apagada antes de gravar a nova; o fim da captura informa quantas foram apagadas. Só entram na conta,
e só podem ser apagados, arquivos em `<camera>/<rotulo>/` com o nome que a captura gera: qualquer
outro arquivo na pasta fica intocado.

#### Câmeras

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

#### Como os recortes são feitos

- O MediaPipe procura até 3 rostos e só o **maior** é recortado: o do motorista, mais perto da
  câmera. Pessoas ao fundo não entram no conjunto de dados.
- O recorte é um quadrado centrado no rosto, com lado 1,5 vez o maior eixo dele
  (`recorte.margem = 0.25`), para incluir testa, queixo e a inclinação da cabeça. Perto da borda,
  a parte fora da imagem é preenchida de preto, e o rosto continua centrado.
- Quadros sem rosto não geram imagem e não consomem a vez: a captura acontece no primeiro quadro
  com rosto depois que o intervalo passou.

#### Resultado do modelo

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

#### Mapeamento na janela

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

#### Privacidade

Os recortes são dados pessoais (LGPD). Eles ficam só neste computador: `saidas/` está no
`.gitignore` e nunca vai para o repositório. Grave apenas pessoas que concordaram, e não induza
sono ou embriaguez reais para gerar dados.

### Métricas faciais (contrato metricas.v1)

Etapa de visão e métricas do sistema de monitoramento do estado do motorista.
Lê um vídeo ou a webcam, extrai os pontos do rosto com o MediaPipe Face Landmarker e grava
uma linha por quadro no formato de `contratos/metricas.v1.json`: EAR de cada olho, abertura
da boca, yaw, pitch e roll, rosto visível, confiança do rastreio e atraso. Nenhum vídeo é gravado.

#### Usar em Python

```bash
uv run python -m entrada metricas video testes/dados/retrato.mp4 --mostrar               # modo vídeo
uv run python -m entrada metricas video <seu-video.mp4> -o saidas/metricas.csv            # outro vídeo
uv run python -m entrada metricas webcam --mostrar [--segundos 60] [-o saidas/w.csv]      # modo ao vivo
uv run python -m entrada comparar a.csv b.csv                                    # diferença quadro a quadro
```

- **Arquivo:** modo vídeo do MediaPipe, síncrono. `t_ms = round(quadro · 1000 / fps)`.
- **Webcam:** a leitura roda numa thread que guarda só o quadro mais recente, e o MediaPipe
  roda no modo ao vivo (assíncrono). Quadros que chegam enquanto ele está ocupado são ignorados.
  `atraso_ms` é o tempo entre a captura e o resultado.

#### Usar no navegador

```bash
node scripts/servidor.mjs    # http://localhost:8000/demo-navegador/
```

A página usa a webcam ou um arquivo de vídeo, processado quadro a quadro com os mesmos
instantes do Python, e exporta o CSV no mesmo contrato. A biblioteca `@mediapipe/tasks-vision`
vem do jsDelivr; a inferência roda no próprio navegador.

Comparar o Python com o navegador no mesmo vídeo, usando o Chrome sem janela:

```bash
uv run python -m entrada metricas video testes/dados/retrato.mp4 -o saidas/py.csv
node scripts/extrair_navegador.mjs testes/dados/retrato.mp4 saidas/js.csv   # fps lido com ffprobe
uv run python -m entrada comparar saidas/py.csv saidas/js.csv
```

O `comparar` sai com código 1 e mostra um ALERTA quando os números de quadros diferem ou o
`t_ms` de um mesmo quadro diverge, o que indica fps diferente nos dois lados. Na página, o
campo "FPS do arquivo" precisa receber o fps real do vídeo, já que o navegador não o informa.

#### Como as métricas são calculadas

| Métrica | Cálculo |
| --- | --- |
| `ear_esq`, `ear_dir` | (\|p2−p6\| + \|p3−p5\|) / (2·\|p1−p4\|), em pixels, com os índices de `entrada/pontos_rosto.json` |
| `abertura_boca` | média de três distâncias verticais internas dos lábios ÷ largura interna da boca |
| `yaw`, `pitch`, `roll` | matriz de transformação facial do MediaPipe, decomposição ZYX, em graus |
| `confianca` | 0 sem rosto; 0,5 ao reencontrar o rosto; depois exp(−resíduo/escala), em que o resíduo é o tremor dos pontos rígidos após alinhar quadros consecutivos, dividido pela distância entre os olhos e suavizado |

Os limiares ficam em `config/extrator.json`. O valor `confianca.escala_residuo = 0.02` é um
ponto de partida e ainda precisa ser calibrado com gravações reais.

## Testes

```bash
./scripts/preparar.sh                                                 # modelo e vídeos de teste, antes do pytest
uv run pytest                                                         # Python (visão e estimador)
npm test                                                              # JavaScript (Node)
RODAR_PARIDADE=1 uv run pytest testes/entrada/test_paridade_navegador.py   # Python × navegador
```

Sem o `preparar.sh`, os testes que usam o MediaPipe são pulados. Os casos de
`testes/casos/geometria.json` são lidos pelos testes das duas linguagens (para regenerar:
`PYTHONPATH=. uv run python testes/casos/gerar_casos.py`).

## Treinamento

O treinamento que ficava em `treinamento/` saiu do repositório. O modelo de imagens usado na
captura, `cnn_sonolencia.keras`, fica fora do git por ser grande (11 MB) e deve ser colocado na
raiz do projeto. `treinamento/exportar_modelo.py`, usado para levar um modelo ao simulador,
depende de um `treinamento/treinar.py` que não está mais aqui; sem o arquivo exportado, o
simulador mostra o modelo como ainda não treinado.

## Estrutura

```
config/          captura (captura.json), extrator de métricas (extrator.json) e estimador
contratos/       contratos de métricas (v1) e de sinal (v1), com exemplos
entrada/         Python da Parte 1: captura e classificador, métricas, fontes, linha de comando
estimador/       Parte 2: estimador e política de ação em Python
demo-navegador/  Parte 1 e 2 no navegador: extrator.js, estimador.js, politica.js, mensagens.js
simulador/       Parte 3: simulador 2D/3D, canal de sinal, scanner e servidor local
exemplos/        dados sintéticos da Parte 2
docs/            guias das Partes 2 e 3
scripts/         preparação, servidor local e extração pelo navegador
testes/          casos compartilhados, testes Python (entrada/, estimador/) e JS (js/)
treinamento/     exportação de modelo para o simulador
```
