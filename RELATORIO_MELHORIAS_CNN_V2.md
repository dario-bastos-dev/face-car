# VIGIA — Relatório de auditoria e melhorias da CNN V2

Data da auditoria: 2026-11-11

## 1. Escopo e proteção do modelo

O arquivo de modelo não foi modificado, convertido ou retreinado. O SHA-256 verificado durante a auditoria foi:

`C87F4D6E362C399B15D1960CE841290C11F006C5CABCDE856CA088F18CAC00C6`

Foi criada uma cópia reversível dos arquivos que seriam alterados em `.vigia-cnn-v2-backup-20261111/`. O diretório do projeto não é um repositório Git.

## 2. Problemas encontrados e evidências

### Seleção padrão do modelo

Antes, `config/analise.json` apontava para `cnn_sonolencia.keras`, e o inicializador existente não passava `--modelo`. Assim, a execução normal não garantia a CNN V2 solicitada, mesmo que uma execução específica pudesse ter sido iniciada com outro argumento.

Correção: a configuração padrão aponta para `C:\Users\alefe\OneDrive\Documentos\vigi\cnn_sonolencia_v2.keras`, e foi criado `INICIAR_VIGIA_V2.bat`, que verifica a existência do arquivo e força esse caminho. O inicializador existente não foi alterado.

### Identidade do modelo não era registrada

Antes, o terminal mostrava apenas tamanho e nomes de classes. Agora o servidor registra `[CNN_META]` em JSON com caminho absoluto, SHA-256, forma de entrada, número de saídas, ordem das classes, hash esperado e `modelo_correto`.

### Estado antigo após desconexão do navegador

Antes, `C.ultimo` permanecia em memória no cliente quando o WebSocket fechava. Isso poderia deixar dados antigos disponíveis até a validade expirar e dificultava distinguir uma nova sessão.

Correção: a previsão anterior é limpa ao receber `cnn_pronto` e ao fechar o WebSocket. O histórico de média do servidor já era criado por sessão (`MediaTemporal` dentro de `sessao_cnn`), portanto não foi alterado.

### CSV sem identificação explícita da etapa

O CSV já separava previsão instantânea, média e índice, mas não identificava explicitamente o percurso da leitura. Foi adicionada a coluna `etapa`, com o valor `webcam-canvas-rgb-websocket-cnn`, e o índice foi renomeado para `indice_risco_derivado` no cabeçalho. Nenhuma imagem é gravada.

## 3. Processamento de imagens auditado

O percurso observado é:

`video da webcam → canvas 160×160 → getImageData RGBA → remoção de alpha/RGB → WebSocket binário → NumPy uint8 → float32 0–255 → predict_on_batch → probabilidades`

Os fatos confirmados no código são:

- o navegador copia os canais R, G e B nessa ordem;
- o servidor reconstrói `tamanho × tamanho × 3` sem trocar canais;
- a inferência do servidor converte para `float32`, sem normalização adicional;
- `entrada/classificador.py` usa BGR→RGB apenas no caminho OpenCV local, que é o equivalente correto para quadros BGR;
- o modelo e a configuração têm três classes na ordem `alerta, sonolento, bocejo`;
- a resolução é lida do modelo e a configuração informada é 160×160;
- o desenho/espelhamento da interface não é enviado ao modelo: o quadro é capturado diretamente do vídeo.

Não foi encontrada incompatibilidade demonstrável de RGB, escala de pixels ou normalização. Por isso, o pré-processamento não foi alterado.

Foi acrescentado um teste automatizado de contrato com padrão RGB não uniforme, além do teste existente de decodificação binária. Esses testes não puderam ser executados neste ambiente por falta de `numpy`/`pytest`.

## 4. Média temporal e índice

A média usa uma janela de 2000 ms, calculada separadamente da previsão instantânea. A resposta WebSocket mantém os campos `classe`/`probabilidades` instantâneos e `media.classe`/`media.probabilidades`.

A média pode atrasar transições e suavizar bocejos curtos; isso é uma consequência esperada da janela e não foi alterado sem evidência capturada pela webcam. Leituras sem rosto não são enviadas ao servidor pelo cliente, e `fresco()` exige rosto visível e resposta recente antes de comandar os níveis.

O índice continua sendo derivado, não uma probabilidade direta da CNN:

`100 × (P(sonolento) + 0,45 × P(bocejo))`, limitado a 100.

Os pesos não foram alterados. O CSV agora identifica o campo como `indice_risco_derivado`; as probabilidades instantâneas e médias continuam em colunas próprias.

## 5. Diagnóstico opcional

O servidor aceita `--diagnostico-cnn` (desativado por padrão). Ele registra linhas `[CNN_DIAG]` em JSON com:

- probabilidades instantâneas e após média;
- classe instantânea e classe média;
- tempo de inferência;
- QPS da janela;
- idade de processamento da última previsão;
- conexão ativa;
- indicador de hash correto.

O servidor também envia a identidade do modelo na mensagem `cnn_pronto`. Não há gravação automática de imagens.

## 6. Arquivos modificados

- `config/analise.json`: caminho padrão para a V2.
- `simulador/servidor.py`: metadados do modelo, hash, diagnóstico e argumento opcional.
- `entrada/classificador.py`: documentação corrigida para a CNN V2.
- `simulador/js/cnn.js`: limpeza de previsão antiga e identificação da etapa no CSV.
- `testes/simulador/test_servidor_cnn.py`: teste de pixels RGB não uniforme e adaptação ao metadado adicional.
- `INICIAR_VIGIA_V2.bat`: novo inicializador específico da V2.
- `RELATORIO_MELHORIAS_CNN_V2.md`: este relatório.

O design visual, cards, cores, navegação, MediaPipe, WebSocket e exportação CSV foram preservados.

## 7. Testes executados

Executados com sucesso:

- `py_compile` nos módulos Python modificados e nos testes;
- validação de sintaxe/parse de `config/analise.json`;
- verificação SHA-256 do arquivo V2.

Não executados por limitações do ambiente:

- `pytest`: o ambiente não possui o pacote `pytest` nem `numpy`;
- testes Node: `node`/`npm` não estão disponíveis no PATH;
- carregamento efetivo Keras e inferência real: dependências Python necessárias não estão disponíveis.

Não há resultados reais de acurácia ou webcam neste relatório. O teste manual continua necessário.

## 8. Protocolo manual recomendado

Com a webcam e o usuário presente, iniciar pelo `INICIAR_VIGIA_V2.bat`; para diagnóstico, acrescentar `--diagnostico-cnn` aos argumentos.

1. Rosto normal por 20 segundos.
2. Fala normal e sorriso por 20 segundos.
3. Bocejos por aproximadamente 20 segundos.
4. Olhos fechados por períodos curtos e controlados, sentado e sem dirigir.
5. Repetir os testes com iluminação diferente.

Em cada etapa, anotar o horário e exportar o CSV ao final. Conferir separadamente `p_alerta`, `p_sonolento`, `p_bocejo`, `media_*`, `classe`, `classe_media`, `indice_risco_derivado`, `ms_previsao` e `etapa`. Não coletar nem armazenar imagens pessoais.

## 9. Conclusões

- A CNN V2 continua sendo o arquivo original verificado por SHA-256; nenhum peso foi alterado.
- O caminho de pixels está compatível com o contrato observado: RGB, 160×160 e faixa 0–255, sem normalização duplicada.
- A queda aparente pode ser causada pela lógica do simulador quando o caminho padrão carregava o modelo antigo, por suavização de 2 segundos ou por estado antigo em uma reconexão. A seleção padrão e o estado antigo foram corrigidos; o efeito da média continua sendo uma hipótese a medir.
- Problemas comprovadamente corrigidos: seleção padrão não exclusiva da V2, ausência de identidade/hash no log, retenção do último quadro após desconexão e ausência de identificação da etapa no CSV.
- Ainda não há evidência suficiente para atribuir limitações de acurácia ao modelo ou justificar novo treinamento. Isso exige executar o protocolo manual e analisar o CSV por etapa e condição de iluminação.

## 10. Adendo final — monitoramento híbrido (11/11/2026)

Este adendo prevalece sobre qualquer observação anterior deste documento que indique
que a inferência real ou o carregamento da V2 não foram possíveis. A execução foi
revalidada com `py -3.12`, TensorFlow 2.20.0, OpenCV 5.0.0 e NumPy 2.5.4.

Foi criado o módulo independente [simulador/js/monitor-hibrido.js](./simulador/js/monitor-hibrido.js).
Ele recebe somente o EAR já produzido pelo MediaPipe e usa os limites já existentes
em `config/analise.json`. Não calcula o índice, não soma probabilidades e não
altera a tabela de transições. Quando não há rosto ou EAR válido, o estado é
invalidado e reiniciado; portanto um fechamento antigo não permanece ativo.

A integração mínima em [simulador/js/ia.js](./simulador/js/ia.js) registra a evidência
estruturada em `V.ia.monitoramentoHibrido`, emite o evento `monitorHibrido` e registra
o evento no log existente. A lógica de alertas continua sendo a já existente:
`estimador` calcula PERCLOS/fechamento contínuo e `politica` aplica seus limiares
originais. Assim, o novo monitoramento fica disponível para o sistema de alertas
sem substituir suas fórmulas, limites ou estados.

Teste adicionado em [testes/js/monitor-hibrido.test.mjs](./testes/js/monitor-hibrido.test.mjs), cobrindo fechamento prolongado, reabertura e perda do rosto.

### Evidências executadas

- `py -3.12 -m py_compile simulador/servidor.py entrada/classificador.py`: aprovado.
- SHA-256 da CNN V2: `C87F4D6E362C399B15D1960CE841290C11F006C5CABCDE856CA088F18CAC00C6`: aprovado.
- Carregamento do servidor: aprovado; entrada `[null,160,160,3]`, 3 saídas e classes `alerta, sonolento, bocejo` registrados em `[CNN_META]`.
- Inferência sintética da CNN V2: aprovada anteriormente com o classificador real; isso valida carregamento/contrato, não acurácia de webcam.
- Página principal em `http://localhost:8020/simulador/?cnnModo=rosto`: carregou a IA e conectou a CNN.
- Teste do módulo no navegador: fechamento em 1000 ms, evento de reabertura e reset sem rosto: aprovados.
- `node --test ...`: não executado porque `node`/`npm` não estão instalados no host; nenhuma dependência foi instalada.

### Arquivos acrescentados ou alterados nesta etapa

- [simulador/js/monitor-hibrido.js](./simulador/js/monitor-hibrido.js): novo módulo aditivo.
- [simulador/js/ia.js](./simulador/js/ia.js): integração mínima do módulo e do evento.
- [testes/js/monitor-hibrido.test.mjs](./testes/js/monitor-hibrido.test.mjs): testes automatizados do novo módulo.
- [RELATORIO_MELHORIAS_CNN_V2.md](./RELATORIO_MELHORIAS_CNN_V2.md): este adendo.

Backup reversível dos arquivos compartilhados: `.vigia-hibrido-backup-20261111-hibrido`.
Nenhum arquivo protegido de Arduino/FSR, física, veículos, controles, layout, cores,
animações, métricas, limites ou pesos da CNN foi alterado nesta etapa.

Limitação restante: o teste de comportamento com olhos reais, iluminações e usuário
precisa ser realizado manualmente com webcam. O novo módulo não é evidência de
acurácia e não justifica alterar o pré-processamento ou treinar outro modelo.
