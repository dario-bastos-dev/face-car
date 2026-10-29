# Extrator de métricas faciais

Etapa de visão e métricas do sistema de monitoramento do estado do motorista.
Lê um vídeo ou a webcam, extrai os pontos do rosto com o MediaPipe Face Landmarker e grava
uma linha por quadro no formato de `contratos/metricas.v1.json`: EAR de cada olho, abertura
da boca, yaw, pitch e roll, rosto visível, confiança do rastreio e atraso. Nenhum vídeo é gravado.

## Preparar

```bash
uv sync                      # Python 3.12, mediapipe, opencv-contrib-python, numpy, pytest
./scripts/preparar.sh        # baixa o modelo e gera os vídeos de teste (precisa de ffmpeg)
```

## Usar em Python

```bash
uv run python -m entrada video caminho.mp4 -o saidas/metricas.csv [--mostrar]   # modo vídeo
uv run python -m entrada webcam --mostrar [--segundos 60] [-o saidas/w.csv]      # modo ao vivo
uv run python -m entrada comparar a.csv b.csv                                    # diferença quadro a quadro
```

- **Arquivo:** modo vídeo do MediaPipe, síncrono. `t_ms = round(quadro · 1000 / fps)`.
- **Webcam:** a leitura roda numa thread que guarda só o quadro mais recente, e o MediaPipe
  roda no modo ao vivo (assíncrono). Quadros que chegam enquanto ele está ocupado são ignorados.
  `atraso_ms` é o tempo entre a captura e o resultado.

## Usar no navegador

```bash
node scripts/servidor.mjs    # http://localhost:8000/demo-navegador/
```

A página usa a webcam ou um arquivo de vídeo, processado quadro a quadro com os mesmos
instantes do Python, e exporta o CSV no mesmo contrato. A biblioteca `@mediapipe/tasks-vision`
vem do jsDelivr; a inferência roda no próprio navegador.

Comparar o Python com o navegador no mesmo vídeo, usando o Chrome sem janela:

```bash
uv run python -m entrada video testes/dados/retrato.mp4 -o saidas/py.csv
node scripts/extrair_navegador.mjs testes/dados/retrato.mp4 saidas/js.csv   # fps lido com ffprobe
uv run python -m entrada comparar saidas/py.csv saidas/js.csv
```

O `comparar` sai com código 1 e mostra um ALERTA quando os números de quadros diferem ou o
`t_ms` de um mesmo quadro diverge, o que indica fps diferente nos dois lados. Na página, o
campo "FPS do arquivo" precisa receber o fps real do vídeo, já que o navegador não o informa.

## Como as métricas são calculadas

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
uv run pytest                                                         # Python
npm test                                                              # JavaScript (Node)
RODAR_PARIDADE=1 uv run pytest testes/entrada/test_paridade_navegador.py   # Python × navegador
```

Os casos de `testes/casos/geometria.json` são lidos pelos testes das duas linguagens
(para regenerar: `PYTHONPATH=. uv run python testes/casos/gerar_casos.py`).

## Estrutura

```
contratos/       contrato de métricas (v1) e exemplo
config/          limiares e parâmetros do extrator
entrada/         Python: fontes, geometria, confiança, extrator, linha de comando
demo-navegador/  página, extrator.js (cálculo) e app.js (MediaPipe e interface)
scripts/         preparação, servidor local e extração pelo navegador
testes/          casos compartilhados, testes Python (entrada/) e JS (js/)
```
