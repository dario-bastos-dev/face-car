# Parte 2 · Estimador e política de ação

A Parte 2 transforma as métricas faciais da Parte 1 em um índice heurístico de sonolência, uma confiança e mensagens para o simulador da Parte 3. Funciona com arquivos e funções puras: não abre câmera, não executa o MediaPipe e não depende de WebSocket.

O resultado é uma **baseline experimental para simulação**. Os limiares ainda não foram validados com motoristas reais ou com o UTA-RLDD. Os testes sintéticos verificam os cálculos, as transições e a equivalência entre linguagens; não demonstram sensibilidade, taxa de falsos alarmes ou segurança de um sistema automotivo.

## Executar sem câmera no Windows

Abra o PowerShell na raiz do repositório. Para trabalhar somente com a Parte 2, use Python 3.12 e instale as dependências mínimas:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install numpy pytest jsonschema
.\.venv\Scripts\python.exe -m estimador replay exemplos/parte2/metricas.csv -o saidas/sinais.jsonl --diagnostico saidas/diagnostico.jsonl
.\.venv\Scripts\python.exe -m pytest testes/estimador
npm test
```

Não é necessário baixar modelos do MediaPipe para esses comandos. O arquivo de exemplo contém métricas sintéticas. `sinais.jsonl` contém as mensagens destinadas ao simulador; `diagnostico.jsonl` contém também a estimativa e o estado a cada passo.

Se o ambiente completo do projeto já estiver preparado, use:

```powershell
uv sync
uv run python -m estimador replay exemplos/parte2/metricas.csv -o saidas/sinais.jsonl --diagnostico saidas/diagnostico.jsonl
uv run pytest
npm test
```

Para a suíte Python completa, as dependências da Parte 1 também devem estar instaladas. Com esse ambiente, a execução direta equivalente é `.\.venv\Scripts\python.exe -m pytest`. Os testes de vídeo/navegador da Parte 1 mantêm seus próprios requisitos opcionais.

## Entrada e organização

A entrada segue integralmente `contratos/metricas.v1.json`: CSV com `t_ms`, `quadro`, `rosto_visivel`, `ear_esq`, `ear_dir`, `abertura_boca`, `yaw`, `pitch`, `roll`, `confianca` e `atraso_ms`. O leitor reaproveita `entrada.contrato.ler_metricas`.

| Arquivo | Responsabilidade |
| --- | --- |
| `config/estimador.json` | Janela, referências dos olhos, qualidade, calibração, transições e emissão |
| `estimador/nucleo.py` | Estimativa pura de índice, PERCLOS e confiança |
| `estimador/politica.py` | Máquina de estados pura |
| `estimador/mensagens.py` | Mensagens de ação e heartbeat |
| `estimador/calibracao.py` | Proposta e avaliação offline de calibração |
| `estimador/replay.py` | Relógio virtual, processamento incremental e respostas |
| `estimador/__main__.py` | Comandos `replay` e `calibrar` |
| `contratos/sinal.v1.json` | JSON Schema das mensagens de saída |
| `demo-navegador/estimador.js`, `politica.js`, `mensagens.js` | Mesma lógica em módulos JavaScript |
| `testes/casos/` | Entradas e expectativas compartilhadas em JSON |

`t_ms` deve ser um inteiro não negativo, seguro em JavaScript, em ordem estritamente crescente. Duplicatas, inversões e amostras posteriores ao instante solicitado são rejeitadas. Nos arquivos de vídeo, o tempo corresponde à posição no vídeo; na captura, ao tempo monotônico desde o início da sessão.

Nesta baseline, boca e pose da cabeça são preservadas no contrato, mas não recebem pesos no índice. Esses sinais podem ser incorporados depois de avaliar seu benefício com dados rotulados na Parte 4.

## PERCLOS, índice e confiança

O PERCLOS representa a proporção de tempo em que os olhos estão pelo menos 80% fechados. A definição e a distinção entre fechamento lento e piscadas rápidas são descritas no [relatório da NHTSA, DOT HS 811 117](https://www.nhtsa.gov/sites/nhtsa.gov/files/811117.pdf). Neste projeto, o fechamento é aproximado pelo EAR; não se mede diretamente a cobertura da pupila.

### Referências por olho

Para cada olho `j`, com referências configuráveis de olho aberto `A_j` e fechado `F_j`:

```text
fechamento_j = (A_j - EAR_j) / (A_j - F_j)
fechado = fechamento_esq >= limiar E fechamento_dir >= limiar
```

O limiar padrão é `0.8`. Os dois olhos precisam satisfazê-lo. Com `A_j = 0.30` e `F_j = 0.05`, isso equivale a `EAR_j <= 0.10`. **EAR igual a 0.20 não significa, por si só, 80% de fechamento.** A normalização depende das referências e permanece uma aproximação que precisa de validação externa.

### Integração temporal

`janela_s` define a janela deslizante; o padrão é 30 segundos. A amostra em `t_i` representa o intervalo:

```text
[t_i, min(t_seguinte, t_i + max_intervalo_ms, agora_ms)]
```

Esse intervalo é recortado pela janela atual. No começo da sequência, considera-se somente o tempo já decorrido. O padrão de `max_intervalo_ms` é 250 ms: uma amostra não pode representar indefinidamente o tempo durante o qual a câmera deixou de produzir dados. O cálculo usa durações, não contagem de quadros ou FPS presumido.

Uma observação só é válida quando há rosto visível, EARs finitos entre 0 e 1, confiança do rastreio de pelo menos 0.5 e atraso finito entre 0 e 500 ms. Campos ausentes ou inválidos tornam o período desconhecido. Eles não significam olhos abertos.

Episódios contínuos de fechamento inferiores a `min_fechamento_ms` — 300 ms por padrão — são excluídos do numerador. Ao alcançar esse mínimo, a duração inteira do episódio que está dentro da janela passa a contar. Uma lacuna sem observação ou uma observação inválida interrompe o episódio. O início real do episódio é considerado mesmo quando precede a borda esquerda da janela.

```text
PERCLOS = tempo_fechado_valido / tempo_valido
cobertura = tempo_valido / tempo_decorrido_na_janela
confianca_media = soma(duracao_i * confianca_i) / tempo_valido
confianca = cobertura * confianca_media * min(1, tempo_valido / min_evidencia_ms)
indice = 100 * max(PERCLOS, min(1, fechamento_continuo_ms / saturacao_fechamento_ms))
```

`min_evidencia_ms` vale 2000 ms e limita a confiança durante o aquecimento. `saturacao_fechamento_ms` vale 3000 ms e permite que um fechamento contínuo eleve o índice antes de ocupar uma parte grande da janela. O fechamento contínuo é limitado à janela atual. O índice está entre 0 e 100 e não representa uma probabilidade clínica de sonolência.

Sem tempo válido, `perclos` e `indice` são `null`. Se a última amostra é inválida ou tem mais de 250 ms, a confiança é zero, mesmo que a janela ainda contenha dados antigos. O resultado também expõe `t_ms`, `tempo_valido_ms`, `tempo_fechado_ms`, `fechamento_continuo_ms`, `cobertura` e `amostras_validas`; a última contagem inclui apenas amostras válidas com duração positiva dentro da janela.

## Política configurável e histerese

A máquina começa em `DEGRADADO`. Uma evidência aceita pela política exige índice válido, confiança de pelo menos 0.65 e estimativa de no máximo 250 ms. A tabela em `config/estimador.json` é avaliada de cima para baixo; a primeira condição satisfeita tem prioridade.

| Origem | Destino | Condição | Duração contínua mínima |
| --- | --- | --- | --- |
| Qualquer estado | `DEGRADADO` | Evidência ausente, inválida, antiga ou de baixa confiança | Imediata, no tick atual |
| `DEGRADADO` | `NORMAL` | Índice < 25 e evidência aceita | 2000 ms |
| `DEGRADADO` | `ATENCAO` | Índice ≥ 25 e evidência aceita | 2000 ms |
| `NORMAL` | `ATENCAO` | Índice ≥ 35 | 1000 ms |
| `ATENCAO` | `NORMAL` | Índice ≤ 25 | 3000 ms |
| `ATENCAO` | `ALERTA` | Índice ≥ 65 | 1500 ms |
| `ALERTA` | `ATENCAO` | Índice ≤ 45 | 3000 ms |
| `ALERTA` | `INTERVENCAO` | Índice ≥ 65 e prazo de resposta expirado | 1000 ms de índice alto |
| `INTERVENCAO` | `ATENCAO` | Índice ≤ 45 | 3000 ms |

Os limiares diferentes para subir e descer implementam a histerese. Por exemplo, depois de entrar em `ATENCAO` com índice 35, o estado não volta para `NORMAL` até permanecer em 25 ou menos durante 3 segundos. Se a condição pendente deixa de valer, sua contagem é apagada.

Ao entrar em `ALERTA`, abre-se um prazo de 5000 ms para resposta do motorista. Uma resposta explícita durante `ALERTA`, com evidência válida, renova esse prazo; ela não reduz o índice nem muda imediatamente o estado. O prazo e a duração mínima do índice alto são requisitos simultâneos: não se somam 5000 + 1000 ms. Se ambos já estiverem cumpridos, a transição ocorre no tick atual.

Use um tick de **100 ms**, inclusive quando a câmera parar. Com ticks pontuais, uma condição detectada pela política é efetivada no primeiro tick que cumpre o prazo e a duração exigidos; a quantização acrescenta no máximo um passo de 100 ms. Isso não é uma garantia de detecção em 5 segundos a partir do início do sono: há aquecimento, janela de evidência e estados anteriores. Atrasos do escalonador também precisam ser considerados em uma integração ao vivo.

Lacunas entre chamadas maiores que `intervalo_maximo_ms` — 500 ms — apagam a contagem de condição contínua. Em `ALERTA`, também reiniciam o prazo de resposta. Assim, uma pausa no processamento não é interpretada como observação contínua de risco.

## Contrato para a Parte 3

Cada linha de saída é um objeto JSON que segue `contratos/sinal.v1.json`. Exemplo da mensagem inicial:

```json
{"versao":1,"sessao":"replay","tipo":"acao","seq":1,"ts":0,"ttl":2000,"estado":"DEGRADADO","nivel":0,"acao":"sistema_degradado","indice":null,"confianca":0.0}
```

| Estado | Nível | Ação |
| --- | --- | --- |
| `NORMAL` | 0 | `monitorar` |
| `ATENCAO` | 1 | `aviso_visual` |
| `ALERTA` | 2 | `alarme_sonoro` |
| `INTERVENCAO` | 3 | `desacelerar_simulado` |
| `DEGRADADO` | 0 | `sistema_degradado` |

`seq` aumenta globalmente entre ações e heartbeats da mesma sessão, começando em 1. `ts` é o instante de emissão em milissegundos do relógio monotônico da sessão, não Unix time. `ttl` é uma duração em milissegundos; a mensagem vence quando `agora >= ts + ttl`. O receptor deve compartilhar ou sincronizar a origem desse relógio. Uma nova sessão exige reinicialização explícita do receptor antes de aceitar a sequência reiniciada.

A emissão de ação ocorre inicialmente, na mudança de estado e na renovação periódica, a cada 500 ms. O heartbeat é emitido inicialmente e a cada 500 ms, com TTL de 2000 ms. Ambos usam a mesma sequência; quando coincidem, a ação é emitida antes do heartbeat. Chamadas atrasadas não inventam mensagens retroativas.

**Heartbeat apenas informa a saúde do canal.** Embora carregue o estado atual, ele não deve disparar uma ação no simulador. Somente mensagens com `tipo: "acao"` são comandos. Evidência inválida força emissão de `DEGRADADO`, cuja ação não solicita desaceleração.

A Parte 3 deverá validar esquema, sessão, ordem e expiração, além de tratar a falta de heartbeat como sistema degradado, sem frear. A Parte 2 fornece o contrato, as mensagens e o replay; o servidor WebSocket e o simulador pertencem à Parte 3. Nenhum comando deste módulo controla um veículo real.

## Replay, resposta do motorista e relógio

```powershell
.\.venv\Scripts\python.exe -m estimador replay exemplos/parte2/metricas.csv -o saidas/sinais.jsonl --diagnostico saidas/diagnostico.jsonl --passo-ms 100 --cauda-ms 1000 --sessao apresentacao-01
```

O replay avança em tempo virtual, sem esperar o tempo real do vídeo. A cauda padrão mantém os ticks por 1000 ms após a última métrica para mostrar a degradação e a continuidade do heartbeat.

`--respostas respostas.json` aceita uma lista JSON de timestamps inteiros em milissegundos, por exemplo `[12000, 17000]`. Eles devem estar em ordem estritamente crescente, dentro do intervalo do replay e na mesma origem temporal das métricas. Uma resposta é consumida no primeiro tick igual ou posterior a seu instante.

## Calibração opcional

A configuração padrão continua sendo usada até uma calibração demonstrar melhoria. O processo offline tem duas etapas:

1. `propor_calibracao` recebe um trecho identificado pelo responsável como motorista alerta e propõe a mediana do EAR aberto de cada olho. Exige pelo menos 5000 ms, 20 amostras válidas, cobertura de 90%, mediana entre 0.15 e 0.50 e coeficiente robusto de variação de no máximo 0.15. Esse coeficiente é `1.4826 * MAD / mediana`. A referência de olho fechado permanece igual.
2. `avaliar_calibracao` compara a configuração original e a proposta em **gravações independentes**, com PERCLOS de referência anotado. Exige ao menos um caso de PERCLOS 0 e um de PERCLOS 1, confiança suficiente nas duas configurações, melhora do erro quadrático médio de pelo menos 0.01 e nenhuma piora em qualquer caso individual.

Sem validação, com empate, ganho insuficiente ou piora, a configuração original é preservada. A presença de poucos segundos alerta não prova por si só que a calibração melhora o sistema. Os limites de plausibilidade também não identificam automaticamente o estado alerta.

O JSON de validação é uma lista de objetos com `id` opcional, `metricas` contendo os registros completos do contrato e `perclos_esperado` entre 0 e 1. Os rótulos devem vir de referência independente, não do próprio estimador. Não reutilize o trecho alerta como validação.

```powershell
.\.venv\Scripts\python.exe -m estimador calibrar saidas/alerta.csv saidas/validacao.json -o saidas/config-calibrada.json --relatorio saidas/relatorio-calibracao.json
.\.venv\Scripts\python.exe -m estimador replay exemplos/parte2/metricas.csv --config saidas/config-calibrada.json -o saidas/sinais-calibrados.jsonl
```

O comando sempre grava a configuração escolhida: a candidata se aprovada, a original caso contrário. O relatório contém `adotada`, `motivo`, qualidade da proposta, erros de cada caso e MSE agregado. A calibração roda em Python; o JSON exportado pode ser usado sem conversão pelo JavaScript. Não foi realizada calibração real nesta entrega. `testes/casos/calibracao.json` contém casos sintéticos de ganho, piora e igualdade para verificar essa regra de adoção.

## API Python

O núcleo não consulta relógio, arquivos ou câmera. O chamador fornece as métricas já disponíveis e o instante atual:

```python
from estimador import carregar_config, estimar
from estimador.politica import estado_inicial, transicionar
from estimador.mensagens import estado_emissor_inicial, emitir

config = carregar_config()
estado = estado_inicial()
emissor = estado_emissor_inicial("sessao-01")

def tick(metricas_ate_agora, agora_ms, respondeu=False):
    global estado, emissor
    estimativa = estimar(metricas_ate_agora, config, agora_ms)
    estado = transicionar(estado, estimativa, agora_ms, config, respondeu)
    emissor, mensagens = emitir(emissor, estado, estimativa, agora_ms, config)
    return estimativa, estado, mensagens
```

`estimar` e as funções de transição/emissão não modificam seus argumentos. O exemplo mantém o estado no chamador. Para arquivos, `estimador.replay.reproduzir` já faz a orquestração e limita o histórico retido à janela com a margem necessária para episódios de fechamento.

Em uma integração ao vivo, chame `tick` a cada 100 ms mesmo sem amostras novas, usando o mesmo relógio da captura. Não envie métricas com `t_ms > agora_ms`. O componente responsável pelo canal deve transmitir as mensagens retornadas.

## API JavaScript e paridade

Os módulos JavaScript não dependem de DOM, câmera ou MediaPipe. Exemplo para um módulo servido dentro de `demo-navegador/`:

```javascript
import { estimar } from "./estimador.js";
import { estadoInicial, transicionar } from "./politica.js";
import { estadoEmissorInicial, emitir } from "./mensagens.js";

const config = await fetch("../config/estimador.json").then(r => r.json());
let estado = estadoInicial();
let emissor = estadoEmissorInicial("sessao-01");

export function tick(metricasAteAgora, agoraMs, respondeu = false) {
  const estimativa = estimar(metricasAteAgora, config, agoraMs);
  estado = transicionar(estado, estimativa, agoraMs, config, respondeu);
  let mensagens;
  [emissor, mensagens] = emitir(emissor, estado, estimativa, agoraMs, config);
  return { estimativa, estado, mensagens };
}
```

O relógio e a retenção do histórico são responsabilidades de quem integra esse módulo. Não calcule o tempo usando somente callbacks de novos quadros: a ausência de quadros também precisa provocar ticks e mensagens de degradação.

Os testes de Python e JavaScript reutilizam os casos JSON e verificam limites temporais, histerese, prazo de resposta, perda de evidência, ordenação e heartbeat. As comparações numéricas admitem apenas a tolerância necessária ao ponto flutuante. A avaliação de eficácia em pessoas, incluindo sensibilidade, falsos alarmes por hora e atraso de detecção, permanece na Parte 4.
