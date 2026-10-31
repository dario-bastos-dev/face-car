# Parte 3 · Simulador do veículo e canal de sinal

A Parte 3 é a interface do projeto: um simulador de direção (visão 2D e cabine 3D) que recebe as mensagens do estimador e mostra o efeito no veículo simulado. Ela integra as Partes 1 e 2 no navegador: o **scanner de rosto** usa o extrator da Parte 1 sobre a webcam e o **estimador da Parte 2** roda na própria página, com o mesmo contrato do WebSocket.

Nenhuma função comanda um veículo real. A desaceleração é apenas simulada.

## Executar

Na raiz do repositório:

```powershell
bash scripts/preparar.sh         # uma vez (Git Bash): baixa modelos/face_landmarker.task; sem ele, a página usa o do Google
python simulador/servidor.py     # ou simulador\INICIAR_SIMULADOR_WINDOWS.bat
```

Abra `http://localhost:8000/simulador/` no Chrome ou Edge (para comandar pelo estimador em Python: `http://localhost:8000/simulador/?ws=ws://localhost:8765`). O servidor serve a raiz do repositório (a página lê `config/`, `contratos/`, `entrada/` e `demo-navegador/`) e, se o pacote `websockets` estiver instalado (`pip install websockets`), abre o estimador em Python em `ws://localhost:8765`. Sem ele, a página funciona normalmente nos modos manual, replay e scanner.

Também funciona com o servidor estático existente: `node scripts/servidor.mjs` e `http://localhost:8000/simulador/`.

## Scanner de rosto (Partes 1 e 2 na página)

No cartão da câmera, à direita da simulação (clicar na imagem amplia o cartão no centro da tela):

| Botão | O que faz |
| --- | --- |
| **◉ Demonstrar** | Liga a câmera e o scanner e desenha a malha do rosto (contorno, olhos, íris, lábios e direção da cabeça). |
| **◌ Invisível** | O scanner continua rodando e comandando o simulador, mas nada é desenhado sobre a imagem. |
| Interruptor **CÂMERA** | Desligar a câmera também desliga o scanner. |
| Interruptor **INFRAVERMELHO** | Filtro só visual (imagem monocromática); o scanner continua lendo o vídeo original. |

Fluxo, em `simulador/js/ia.js`:

```text
webcam → MediaPipe Face Landmarker (modo VIDEO, marcas de tempo crescentes)
       → demo-navegador/extrator.js: CalculadoraMetricas  (contrato metricas.v1)
       → a cada 100 ms, mesmo sem quadro novo:
           estimar → transicionar → emitir   (demo-navegador/estimador.js, politica.js, mensagens.js)
       → mensagens sinal.v1 → simulador/js/sinal.js (mesmo caminho do WebSocket e do replay)
```

- `t_ms` e `agora_ms` usam o mesmo relógio monotônico da sessão (`performance.now()` desde o início do scanner); o instante de captura do quadro vem de `requestVideoFrameCallback`.
- O histórico retido é `janela_s` + `min_fechamento_ms` + `max_intervalo_ms`, como no replay da Parte 2.
- As barras do cartão mostram métricas **reais**: abertura dos olhos (EAR normalizado pelas referências de `config/estimador.json`), abertura da boca (`abertura_boca`; 100% = 0,7), pitch da cabeça, PERCLOS e índice do estimador.
- Bocejo: boca acima de 0,5 por 1,5 s mostra o selo "BOCEJO" e é registrado no log. Por enquanto é só indicação; não entra na política (limiares ainda não calibrados).
- O estimador começa em `DEGRADADO` e precisa de evidência suficiente (`min_evidencia_ms`, confiança mínima) antes de passar a `NORMAL`. Os limiares ainda não foram calibrados com motoristas reais: o scanner **não está treinado**.
- Nenhum quadro sai do navegador e nada é gravado. O botão **↓ Métricas reais (CSV)** exporta só as métricas, no contrato `metricas.v1`, para alimentar a Parte 4.

## Canal de sinal

`simulador/js/sinal.js` é a única entrada de mensagens. Só um canal comanda por vez:

| Canal | Origem |
| --- | --- |
| IA na página | Scanner + estimador JS, por chamada de função (item 3 do plano) |
| WebSocket | Estimador em Python (`simulador/servidor.py`), com o Python como servidor |
| Replay | Arquivo `.jsonl`/`.json` com mensagens `sinal.v1` (por exemplo, o `sinais.jsonl` do `estimador replay`) |
| Manual | Botões Normal/Atenção/Crítico/Intervenção: fecham o canal ativo |

Validação de cada mensagem, em `simulador/js/receptor.js` (função pura, testada em `testes/js/receptor.test.mjs`):

- esquema de `contratos/sinal.v1.json`, inclusive a coerência estado ↔ nível ↔ ação;
- uma sessão por vez: outra sessão exige reinicialização explícita (`outra_sessao`);
- `seq` estritamente crescente (`fora_de_ordem`) e expiração quando `agora >= ts + ttl` (`vencida`). O relógio da sessão do emissor é alinhado ao local na primeira mensagem aceita;
- heartbeat só informa a saúde do canal e **nunca** dispara ação;
- sem mensagem válida até vencer a última, ou com o canal encerrado durante um alerta, o simulador mostra **sistema degradado** e mantém a velocidade, **sem frear**.

| Estado (sinal.v1) | Simulador |
| --- | --- |
| `NORMAL` | condução normal |
| `ATENCAO` | aviso visual e sonoro |
| `ALERTA` | alerta crítico e alarme |
| `INTERVENCAO` | pisca-alerta e desaceleração simulada |
| `DEGRADADO` | "sistema degradado", sem frenagem |

### Mensagens da página para o estimador (WebSocket)

```json
{"tipo": "status_entrega", "sessao": "python-…", "seq": 12, "status": "aceita", "ts_local": 1234}
{"tipo": "resposta_motorista", "sessao": "python-…", "acao": "confirmou_atencao", "veiculo": "car", "ts_local": 5678}
```

`status` é `aceita`, `invalida`, `outra_sessao`, `fora_de_ordem` ou `vencida`. A resposta do motorista (tecla `A`) vira `resposta_motorista=True` no próximo tick da política — na página e no Python.

### Registro

A página guarda as mensagens e ações no registro de eventos (exportável em JSONL). O servidor grava tudo o que envia e recebe em `saidas/simulador-<sessao>.jsonl`. Nenhum vídeo é registrado.

## Preparado para a Parte 4

- `treinamento/exportar_modelo.py` converte o modelo de `treinar.py` (StandardScaler + LogisticRegression) em `modelos/modelo_sonolencia.json`.
- `simulador/js/modelo.js` lê esse arquivo e calcula, a cada tick, a probabilidade de sonolência com os mesmos atributos do treino (`ear` médio na janela, `perclos` do estimador e `boca` média). A página mostra o valor no cartão da câmera; sem o arquivo, mostra "ainda não treinado". A probabilidade **ainda não comanda** a política: ligar o modelo à política é decisão da Parte 4, depois da avaliação por pessoa.
- O CSV de métricas reais do scanner segue o contrato `metricas.v1`, o mesmo formato que o extrator em Python grava.

## Arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `simulador/index.html`, `css/vigia.css` | Página e visual |
| `simulador/js/core.js` | Estado do veículo, mundo, tráfego, níveis e registro |
| `simulador/js/sinal.js` | Canal de sinal: IA, WebSocket, replay e manual |
| `simulador/js/receptor.js` | Validação pura do contrato `sinal.v1` |
| `simulador/js/ia.js` | Scanner: MediaPipe + extrator (Parte 1) + estimador (Parte 2) |
| `simulador/js/modelo.js` | Aplicação do modelo exportado da Parte 4 |
| `simulador/js/driver-monitor.js` | Webcam, malha do rosto e barras de métricas |
| `simulador/js/world3d.js`, `cabin.js`, `scene2d.js`, `overlay2d.js`, `audio.js` | Cabine 3D (Three.js), visão 2D, painéis e sons |
| `simulador/servidor.py` | HTTP + estimador em Python por WebSocket |
| `treinamento/exportar_modelo.py` | Exporta o modelo treinado para o navegador |
| `testes/js/receptor.test.mjs` | Testes do receptor e do modelo |

## A validar

- Os limiares de `config/estimador.json` com motoristas reais (o scanner ainda não está calibrado).
- Desempenho do MediaPipe com a cena 3D no notebook da apresentação.
- `@mediapipe/tasks-vision` vem do jsDelivr, como na demo da Parte 1: sem internet, o scanner não carrega (o restante do simulador funciona; o Three.js está em `simulador/vendor/`).
- A biblioteca `websockets` no lado Python ainda não está no `pyproject.toml`; instale com `pip install websockets`.
