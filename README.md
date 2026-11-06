# Face-Car · Visão, estimador e política de ação

## Parte 3 · Simulador e integração

Simulador de direção (visão 2D e cabine 3D) que integra as Partes 1 e 2 na própria página:
a webcam do navegador passa pelo mapeamento do rosto (MediaPipe) e pelo **modelo de imagens**
da Parte 1 (`cnn_sonolencia.keras`), e o estimador e a política da Parte 2 transformam o
resultado em mensagens `sinal.v1`, que comandam o veículo simulado.

```bash
pip install websockets           # o servidor também precisa do TensorFlow (uv sync) e do modelo na raiz
python simulador/servidor.py     # http://localhost:8000/simulador/  (ou simulador\INICIAR_SIMULADOR_WINDOWS.bat)
```

```text
webcam (navegador) ─┬─ MediaPipe → olhos, boca, cabeça, olhar e eventos (simulador/js/rosto.js,
                    │              mesmas regras e limiares de entrada/rosto.py e config/analise.json)
                    │            → métricas metricas.v1 e PERCLOS (Partes 1 e 2 em JS)
                    └─ quadro inteiro reduzido a 160×160, RGB, sem desenho
                         → WebSocket /cnn → simulador/servidor.py → cnn_sonolencia.keras
                         → sonolento / alerta / bocejo e a média dos últimos 2 s
índice = 100 × (sonolento + 0,45 × bocejo)  →  política da Parte 2  →  sinal.v1  →  simulador
```

- **Cartão da câmera:** **◉ Demonstrar** liga o scanner com o mapeamento (contornos, íris,
  setas do olhar e da cabeça, painel com cabeça, olhar, olhos, boca e a classe do modelo);
  **◌ Invisível** mantém tudo rodando e mostra só o quadrado do rosto. Abaixo das barras, o
  painel **Modelo CNN** mostra as probabilidades médias. Clicar na imagem amplia o cartão.
- **Infravermelho:** usa o sensor IR se o navegador enxergar uma câmera com "IR" ou "infra" no
  nome (o registro de eventos lista as câmeras encontradas); senão, aplica só um filtro visual
  monocromático. Muitas câmeras IR de notebook (Windows Hello) não são liberadas para o navegador.
- **Leitura só pelo modelo (Parte 4):** o estado do motorista vem apenas do modelo treinado pelo
  time, com as classes e a janela de `config/analise.json` (média de 2 s, como em `entrada/__main__.py`).
  A média vira o índice `100 × (sonolento + 0,45 × bocejo)`, que passa pela política da Parte 2.
  Sem resultado recente do modelo (servidor, TensorFlow ou arquivo ausentes), o simulador fica em
  DEGRADADO, sem frear. Sem o motorista na câmera, como na análise em Python, nenhum quadro vai ao
  modelo e o painel mostra `motorista não visível · sem análise`. O quadro do modelo é capturado à
  parte do MediaPipe, a até 8 por segundo, para a taxa não cair quando o rastreio estiver lento. A geometria do rosto (olhos, PERCLOS, boca, cabeça) continua medida e
  mostrada, mas não comanda. O modelo atual (`cnn_sonolencia_v2`) marca 75% a 98% de "sonolento"
  num retrato acordado e sorrindo; vale reavaliar o treino com imagens de webcam.
- **Validação:** **↓ Leituras do CNN (CSV)**, no registro de eventos, exporta cada resultado do
  modelo (classe e probabilidades do quadro, média da janela, índice, estado do sinal e nível do
  simulador) para comparar com o que de fato aconteceu.
- **Intervenção:** com o pisca-alerta ligado, o veículo reduz para cerca de 30 km/h, vai devagar
  para o centro do acostamento e só então para. Quando a intervenção termina, volta à faixa com
  seta para a esquerda, só com espaço livre; nenhum veículo aparece atrás durante a volta nem nos
  3 s seguintes.
- **Alarmes sonoros:** atenção e crítico com os toques de sempre; na intervenção, a sirene e a
  mesma buzina em três toques seguidos, como um alarme. As buzinas gravadas ficam em
  `simulador/assets/sons/`; em algumas passagens, quem vem na contramão dá duas buzinadas, com
  volume, lado e tom acompanhando a distância.
- **Modo de condução (Padrão / Volante):** no Padrão, o simulador dirige sozinho. No Volante, o
  motorista dirige por um controlador de jogo (Gamepad API; o navegador só o enxerga depois de
  apertar um botão dele): eixo X é o volante (gira o da cabine 3D e liga a seta do lado), eixo Y
  para cima acelera e para baixo freia (nunca dá ré) e o chapéu (POV), em qualquer direção, buzina (um som contínuo enquanto estiver apertado). O botão 5 alterna a visão entre 2D e cabine 3D.
  Sem controlador, valem as setas do teclado e B. Na intervenção, os comandos travam e o VIGIA leva
  o veículo ao acostamento; ao terminar, o motorista volta a dirigir. O estado do controlador
  aparece nas configurações.
- **Eventos:** olhos fechados por mais de 1 s, olhos reabertos e bocejo vão para o registro de
  eventos; piscadas são só contadas.
- **Privacidade:** os quadros só existem na memória do navegador e do servidor; nada é gravado.
- **Outros canais:** o estimador em Python sobre um CSV (`?ws=ws://localhost:8765`) e o replay
  de mensagens gravadas continuam disponíveis. Só um canal comanda por vez.
- **Testes:** `npm test` (receptor, rosto) e `uv run pytest testes/simulador` (serviço do
  modelo, com um modelo falso).

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

- **Análise em tempo real com o modelo de imagens:** cada quadro vai para
  `cnn_sonolencia.keras`, sem gravar nada (`python -m entrada webcam|video`).
- **Métricas faciais em CSV:** uma linha por quadro no contrato `metricas.v1`, que alimenta o
  estimador da Parte 2 e o simulador da Parte 3 (`python -m entrada metricas webcam|video`).

### Preparar
```bash
uv sync                      # Python 3.12, mediapipe, opencv-contrib-python, numpy, pytest
./scripts/preparar.sh        # baixa o modelo e gera os vídeos de teste (precisa de ffmpeg)
```

### Análise em tempo real com o modelo de imagens

Cada quadro da câmera vai, na memória, para o modelo `cnn_sonolencia.keras`; **nada é gravado**.
O terminal mostra, para cada quadro, o vetor que o modelo devolveu, a classe escolhida e o tempo da
previsão; uma vez por segundo, mostra a média das probabilidades dos últimos 2 s, que é também o que
aparece no painel da janela:

```
[rgb    3,645 s] saída [0,9965 0,0000 0,0035] → alerta (11 ms) | olhos abertos (EAR 0,27) · boca fechada (0,01) · cabeça frente
[rgb    3,697 s] saída [0,0351 0,9636 0,0013] → sonolento (21 ms) | olhos fechados (EAR 0,09) · boca fechada (0,01) · cabeça baixo
[rgb    3,901 s] evento: piscada (0,20 s)
[rgb    4,6 s] média 2 s: alerta 73,4%  (sonolento 21,3%, bocejo 5,3%)  · 20 q/s
```

O vetor segue a ordem de `classificador.classes` (`alerta`, `sonolento`, `bocejo`) e soma 1. A saída de um quadro
oscila bastante de um quadro para o seguinte; a média separa uma piscada, que dura uma fração de
segundo, do olho que fica fechado. `q/s` é quantos quadros por segundo estão sendo analisados, e
`--sem-log` mostra só os eventos e as médias. Os avisos internos do TensorFlow ficam desligados;
para vê-los, rode com `TF_CPP_MIN_LOG_LEVEL=0`.

#### Olhos, boca e cabeça

Depois da barra `|`, cada linha mostra o estado do rosto. Ele **não vem do modelo**, que classifica
o quadro inteiro como sonolento, alerta ou bocejo: vem da geometria do rosto (MediaPipe), com as
mesmas fórmulas do extrator de métricas. As duas fontes são independentes; o bocejo do modelo e o
evento `bocejo` da geometria podem discordar. O EAR mede a abertura do olho e a abertura da boca é a distância interna dos lábios
dividida pela largura da boca. Os eventos aparecem numa linha própria, também com `--sem-log`:

| Evento | Quando |
| --- | --- |
| `piscada (0,20 s)` | olhos fechados por até 0,4 s e reabertos |
| `olhos fechados há mais de 1 s` | enquanto continuam fechados; ao reabrir, `olhos reabertos após …` |
| `olhos fechados por …` | fechados por mais que uma piscada e menos de 1 s |
| `bocejo` | boca aberta por mais de 1,5 s (menos que isso é fala) |
| `cabeça baixa há mais de 15 s` | cabeça apontando para baixo por 15 s seguidos; ao levantar, `cabeça levantada após …`. Olhar para baixo por menos tempo (painel, rádio) não gera evento, e a linha mostra `cabeça baixo há 4 s` enquanto conta |

Os limiares ficam em `rosto`, em `config/analise.json`: EAR abaixo de 0,18 é olho fechado
(`ear_olho_fechado`) e abertura acima de 0,40 é boca aberta (`abertura_boca_aberta`). São pontos de
partida: o EAR de olho aberto muda com a pessoa, a câmera, a luz e os óculos (na webcam colorida
ficou entre 0,21 e 0,30), então convém ajustá-los olhando os valores do log.

```bash
uv run python -m entrada webcam                         # pergunta a câmera; abre a janela
uv run python -m entrada webcam --camera ir --sem-janela
uv run python -m entrada webcam --camera todas --segundos 60
uv run python -m entrada video <seu-video.mp4> [--mostrar]
```

| Opção | Padrão | Efeito |
| --- | --- | --- |
| `--camera` | menu (webcam), `rgb` (vídeo) | webcam: `rgb`, `ir` ou `todas` (repetível); vídeo: nome mostrado no terminal |
| `--segundos` | sem limite | webcam: parar depois deste tempo |
| `--sem-janela` | — | webcam: analisar sem abrir a janela |
| `--sem-log` | — | mostrar só os eventos e as médias, sem uma linha por quadro |
| `--porta-sensor` | `sensor.porta` | webcam: porta serial do sensor de pressão |
| `--sem-sensor` | — | webcam: analisar sem o sensor, só com o modelo |
| `--mostrar` | ligado na webcam, desligado no vídeo | janela com o resultado e o mapeamento do rosto |

#### Sensor de pressão no volante (FSR402)

Com o sensor conectado, a análise junta o modelo com a pressão das mãos no volante, lida pela
serial com o `pyserial`: abaixo de **400** é sinal de sonolência (a mão afrouxa), 400 ou mais é sinal
de alerta. O sensor chega por um microcontrolador que envia um número por linha; com um Arduino, o
FSR402 num divisor de tensão (por exemplo, com um resistor de 10 kΩ) ligado ao pino A0:

```cpp
void setup() { Serial.begin(115200); }
void loop() { Serial.println(analogRead(A0)); delay(20); }   // 0 a 1023, ~50 leituras por segundo
```

```bash
uv run python -m entrada webcam --camera rgb                          # porta de sensor.porta
uv run python -m entrada webcam --camera rgb --porta-sensor /dev/ttyACM0
uv run python -m entrada webcam --camera rgb --sem-sensor             # só o modelo
```

- **Índice de sonolência**, de 0 a 1: a probabilidade média de `sonolento` do modelo nos últimos
  2 s, mais os bônus abaixo (o índice não passa de 1). Sem bônus, é só o modelo.
- **Volante frouxo por 15 s:** com a pressão abaixo de 400 por 15 s seguidos, soma 0,3 ao índice
  enquanto continuar baixa. Soltar a mão por menos tempo (trocar a marcha, ajustar o rádio) não
  conta, e uma leitura de 400 ou mais recomeça a contagem. A linha de cada quadro mostra
  `volante 112 (baixo há 4 s)` enquanto conta; aos 15 s aparece o evento
  `pressão no volante abaixo de 400 há mais de 15 s` e, ao apertar de novo,
  `volante apertado de novo após …`.
- **Cabeça baixa por 15 s:** da mesma forma, soma 0,3 enquanto a cabeça continuar baixa. Se ela
  baixar tanto que o MediaPipe perca o rosto, vale a regra do motorista fora da câmera.
- A linha do índice mostra o que entrou, por exemplo
  `índice de sonolência 0,70 (modelo 0,40 · volante frouxo +0,30) → SONOLÊNCIA`.
- **Alerta:** começa quando o índice chega a 0,6 e só termina abaixo de 0,4, para não ficar ligando e
  desligando. Um bônus sozinho, com o modelo em alerta, não dispara o alerta (a mão solta pode ser
  só cansaço do braço; a cabeça baixa, distração com o celular); dispara com o modelo em dúvida
  (0,3 ou mais) ou com os dois juntos, volante frouxo e cabeça baixa.
- **Motorista fora da câmera:** o quadro não vai para o modelo, o sensor é ignorado e nenhum alerta
  é gerado; o terminal mostra `motorista não visível`, e um alerta em andamento é suspenso. As
  contagens de 15 s do volante e da cabeça recomeçam quando ele volta.
- **Sensor ausente ou desconectado:** a análise avisa e segue só com o modelo; se o sensor parar de
  enviar, a contagem do volante recomeça.
- Ao abrir a porta, o que estava no buffer (enviado antes) e a primeira linha, que pode vir pela
  metade, são descartados.

Porta, velocidade, limiar e o tempo do volante frouxo (`pressao_baixa_alerta_ms`) ficam em
`sensor`; o tempo da cabeça baixa em `rosto.cabeca_baixa_alerta_ms`; os bônus e os limiares do
alerta em `fusao`, em `config/analise.json`; são pontos de partida a ajustar com testes reais. No Linux, o usuário precisa
estar no grupo da serial (`uucp` no Arch, `dialout` no Debian e no Ubuntu); veja a porta com
`ls /dev/ttyUSB* /dev/ttyACM*`.

#### O modelo

O modelo atual é o FaceCar_CNN_V2 (MobileNetV2), treinado com o quadro inteiro em RGB,
redimensionado para 160×160, com os pixels de 0 a 255 (a normalização é uma camada dele); a análise
lê o tamanho do próprio modelo e prepara a imagem do mesmo jeito, antes de qualquer desenho na
janela. O modelo devolve 3 probabilidades, nesta ordem: `alerta` (0), `sonolento` (1) e
`bocejo` (2), com valores de 0 a 1 que somam 1 (`classificador.classes` em `config/analise.json`;
o programa confere que o número de classes bate com o de saídas e que cada previsão soma 1, e
termina com erro se não for assim), que também define a janela da média
(`janela_ms`) e o intervalo das linhas no terminal (`intervalo_terminal_ms`). O arquivo fica fora
do git (cerca de 10 MB) e deve estar na raiz do projeto; sem ele, o comando termina com erro. A câmera
infravermelha entrega imagens em cinza, diferentes das coloridas do treino, então o resultado dela
tende a valer pouco.

#### Câmeras

Sem `--camera`, o comando `webcam` mostra um menu com as câmeras configuradas e a opção `todas`;
responda com o número ou o nome, ou Enter para a padrão (`camera_padrao`, hoje `rgb`). Fora de um
terminal interativo, ele usa a padrão sem perguntar. As câmeras ficam em `config/analise.json` pelo
caminho fixo em `/dev/v4l/by-path/`, e não pelo número (`/dev/video0`), que pode mudar ao reiniciar
ou reconectar; em outro computador, veja os caminhos com `ls -l /dev/v4l/by-path/`.

| Nome | Câmera | Imagem |
| --- | --- | --- |
| `rgb` | HD Webcam | colorida, 640×480 |
| `ir` | IR Camera | infravermelha em tons de cinza, 640×360 |

#### Mapeamento na janela

A janela desenha o contorno do rosto, dos olhos e dos lábios, as íris, uma seta com a direção da
cabeça (pela matriz de pose do MediaPipe) e setas com a direção do olhar (pela posição da íris entre
os cantos do olho), e escreve no painel para onde cada uma aponta (`frente`, `esquerda`,
`baixo e direita`…), do ponto de vista do motorista: a câmera não espelha a imagem, então olhar para
a esquerda dele leva o rosto para a direita da imagem. O MediaPipe procura até 3 rostos e mapeia só
o maior, o do motorista; o rosto é procurado em todo quadro, com ou sem janela, porque também
alimenta olhos, boca e cabeça no terminal. Sem tela gráfica, como por SSH, a análise segue sem
janela e avisa.

#### Privacidade

Nenhum quadro é gravado nem sai do computador: a análise acontece na memória.

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
- **Rosto:** o MediaPipe procura até 3 rostos (`mediapipe.max_rostos` em `config/extrator.json`)
  e as métricas são do maior, o do motorista, como na análise; a demo do navegador faz o mesmo.
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
RODAR_PARIDADE=1 uv run pytest testes/entrada/test_metricas.py   # Python × navegador
```

Sem o `preparar.sh`, os testes que usam o MediaPipe são pulados. Os casos de
`testes/casos/geometria.json` são lidos pelos testes das duas linguagens (para regenerar:
`PYTHONPATH=. uv run python testes/casos/gerar_casos.py`).

## Treinamento

O treinamento que ficava em `treinamento/` saiu do repositório. O modelo de imagens usado na
análise, `cnn_sonolencia.keras`, fica fora do git por ser grande (cerca de 10 MB) e deve ser colocado na
raiz do projeto. O simulador usa o mesmo arquivo pelo servidor (`simulador/servidor.py`).

## Estrutura

```
config/          análise e câmeras (analise.json), extrator de métricas (extrator.json) e estimador
contratos/       contratos de métricas (v1) e de sinal (v1), com exemplos
entrada/         Python da Parte 1: análise com o classificador, métricas, fontes, linha de comando
estimador/       Parte 2: estimador e política de ação em Python
demo-navegador/  Parte 1 e 2 no navegador: extrator.js, estimador.js, politica.js, mensagens.js
simulador/       Parte 3: simulador 2D/3D, canal de sinal, scanner, modelo de imagens e servidor local
exemplos/        dados sintéticos da Parte 2
docs/            guias das Partes 2 e 3
scripts/         preparação, servidor local e extração pelo navegador
testes/          casos compartilhados, testes Python (entrada/, estimador/) e JS (js/)
treinamento/     notebook do modelo de imagens (modelo.ipynb)
```
