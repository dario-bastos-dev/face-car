# Relatório final — diagnóstico CNN V2, CNN V3 e proposta de V4

**Data:** 12/11/2026  
**Escopo executado:** integração visual diagnóstica, análise dos erros já observados na CNN V3, verificação do pré-processamento/previsões/indicadores e correções mínimas de integração.  
**Decisão de segurança:** nenhuma CNN V4 foi criada, treinada, salva ou ligada ao simulador. A V3 segue somente observacional. Este trabalho não altera modelos, limiares de alerta, política, intervenções ou controles.

## 1. Resumo executivo

O painel independente anteriormente comparava apenas dois pré-processamentos da CNN V2 e exibia o EAR. Foi ampliado para apresentar, a partir de uma mesma captura:

1. CNN V2 sobre o quadro inteiro;
2. CNN V2 sobre o recorte derivado do FaceLandmarker;
3. CNN V3 de olhos, com caixa Haar e pré-processamento do runtime;
4. MediaPipe, com indicação de face, caixa normalizada e EAR.

O quadro enviado ao diagnóstico agora respeita o limite de largura de 640 px do runtime do simulador. Essa correspondência é relevante: nos exemplos de auditoria existentes, executar a V3 com a imagem original de 1280×720 deu probabilidades diferentes de executar após reduzi-la para 640×360. O painel anterior não impunha esse limite. A correção mantém a proporção e aproxima a captura do caminho real.

Foi encontrada e corrigida outra falha de integração: coordenadas Haar do OpenCV podem ser `numpy.int64`, que não são serializáveis diretamente pelo JSON padrão. O diagnóstico converte essas coordenadas em `int` nativo antes de enviá-las ao navegador.

As verificações confirmaram o carregamento dos dois modelos e do cascade, dimensões/saídas esperadas, faixa válida nas previsões de teste e paridade do recorte V3 com a função do simulador. **10 testes de `testes/simulador` passaram.** A reprodução dos dois exemplos de erro, no quadro reduzido para 640×360, retornou 0,46452 para a foto aberta e 0,44538 para a foto fechada: a primeira fica abaixo do limiar 0,5 e a segunda é um falso negativo que permanece.

Isso não demonstra confiabilidade em webcam. As 56 previsões consecutivas classificadas como olhos fechados, relatadas anteriormente, não têm imagens ou dados por quadro disponíveis para replay. A validação do dataset tampouco é independente por pessoa/sessão. A conclusão continua sendo: **V3 experimental, sem autorização para controlar alertas ou intervenções; coletar e avaliar dados representativos antes de qualquer novo treino.**

## 2. Alterações realizadas

### Painel

Arquivos principais:

- `simulador/diagnostico-cnn.html`
- `simulador/js/diagnostico-cnn.js`
- `simulador/diagnostico_cnn.py`
- `testes/simulador/test_diagnostico_cnn.py`

O painel mostra quatro cartões separados. A V2 mantém probabilidades instantâneas, classe, latência e média temporal. A V3 mostra probabilidade de olhos fechados, resultado no limiar já usado pelo runtime (0,5), estado do recorte, caixa Haar e latência. O cartão MediaPipe informa detecção facial, EAR, origem e caixa normalizada. O EAR continua claramente identificado como indicador geométrico independente, não como saída de CNN.

O CSV passa a incluir estado/erro, probabilidade, decisão e latência da V3, além dos indicadores MediaPipe e das caixas. Nenhum quadro ou vídeo é gravado.

### Pré-processamento e limites do painel

- Captura: o vídeo é analisado pelo FaceLandmarker e o quadro transmitido é reduzido a no máximo 640 px de largura, preservando a proporção.
- CNN V2 A: quadro inteiro redimensionado para 160×160.
- CNN V2 B: recorte pela caixa normalizada do FaceLandmarker, margem de 20%, conversão BGR/RGB do caminho de comparação, preservação da proporção e padding preto.
- CNN V3: Haar seleciona a maior face, margem de 8%, RGB 160×160 com `INTER_AREA`; os pixels são fornecidos em 0–255 e a normalização segue interna ao modelo. A caixa Haar é calculada separadamente da caixa do MediaPipe.
- MediaPipe: calcula a caixa facial e o EAR; esses indicadores são apresentados à parte das probabilidades dos modelos.

Se a V3 ou o cascade não carregar, o servidor informa o motivo e mantém a comparação da V2. Se a V3 falhar durante inferência, o erro é exibido/logado, sem interromper a V2. Essa página é diagnóstica, não altera a decisão do simulador.

## 3. Artefatos e modelos verificados

O modelo V2 é carregado do caminho definido em `config/analise.json`; o comparador também confere o hash esperado. A V3 é carregada de `cnn_olhos_v3.keras`. Os hashes abaixo foram conferidos e coincidem com os registrados na auditoria existente:

| Artefato | Entrada | Saída | SHA-256 |
|---|---|---|---|
| V2 (`cnn_sonolencia_v2.keras`) | `[None, 160, 160, 3]` | 3 classes: `alerta`, `sonolento`, `bocejo` | `C87F4D6E362C399B15D1960CE841290C11F006C5CABCDE856CA088F18CAC00C6` |
| V3 (`cnn_olhos_v3.keras`) | `[None, 160, 160, 3]` | 1 probabilidade sigmoid, classe positiva `olhos_fechados` | `BAB4CCEC941F6BF2C423A403D090E2E15396919AF3D1A3C89359B4DB52AB7F4F` |
| Cascade Haar | — | detector facial do recorte V3 | `simulador/haarcascade_frontalface_default.xml` |

O ambiente de verificação foi Python 3.12.10, TensorFlow 2.20.0/Keras 3.15.1, OpenCV 5.0.0 e NumPy 2.5.4. Os modelos foram carregados e executados, sem treino. A saída da V2 em entrada sintética foi finita e somou aproximadamente 1; a saída V3 sintética foi finita e ficou no intervalo `[0,1]`. Previsões sintéticas servem apenas para validar o contrato de saída, não para estimar acurácia ou comportamento humano.

Os pesos e o cascade não foram alterados. O arquivo V3 já existia no workspace; não foi produzido um novo artefato de modelo.

## 4. Análise dos erros da CNN V3

### Causa de integração comprovada

A auditoria anterior encontrou divergência entre a caixa facial usada no treinamento (Haar) e a caixa inicialmente usada na integração (MediaPipe). No conjunto de validação reconstruído, o proxy FaceMesh aumentou falsos positivos de olhos fechados e alterou fortemente probabilidades de algumas imagens abertas. Para `olhos_abertos/foto_0071.jpg`, foram registrados 0,305 no recorte de treino, 0,465 no Haar a 640 px e 0,869 no proxy FaceMesh. O proxy não é replay idêntico do FaceLandmarker do navegador, mas o teste pareado demonstrou que a geometria do recorte podia deslocar a previsão.

A entrada operacional da V3 já havia sido corrigida para usar Haar. O painel novo também aplica o Haar, em vez de reutilizar a caixa MediaPipe da V2. O MediaPipe continua ativo para suas próprias métricas.

### Reexecução dos exemplos disponíveis

Foram reexecutadas as cópias de exemplo já presentes em `saidas/diagnostico_cnn_v3_20261112/` com o modelo atual e o Haar:

| Exemplo | Rótulo/estado visual registrado | Entrada Haar | Probabilidade V3 `olhos_fechados` | Resultado em 0,5 |
|---|---|---|---:|---|
| `falso_positivo_fechado_foto_0071.jpg` | olhos abertos | 640×360, caixa com margem de 8% | 0,46452 | aberta — não cruza o limiar |
| `falso_negativo_aberto_foto_0044.jpg` | olhos fechados | 640×360, caixa com margem de 8% | 0,44538 | aberta — falso negativo |

Como controle de integração, as mesmas cópias em 1280×720 deram 0,30978 e 0,28199. Esse quadro não representa o caminho do simulador, que limita o quadro a 640 px de largura; por isso, o painel foi ajustado para usar o mesmo limite. A redução do navegador (`canvas.drawImage`) e a redução OpenCV dos exemplos não são garantidamente idênticas pixel a pixel; a correspondência exata ainda deve ser observada em uma sessão de webcam.

O primeiro exemplo é um falso positivo conhecido no proxy FaceMesh antigo, mas não no recorte Haar testado; o segundo demonstra um falso negativo persistente. Corrigir detector/caixa reduz uma divergência real, porém não elimina os erros do modelo.

### Avaliação existente do dataset

Os números a seguir vêm de `RELATORIO_AUDITORIA_CNN_V3.md`; são diagnóstico reutilizado, não teste independente:

- Dataset: 299 imagens JPEG, 1280×720; Haar encontrou rosto em 273. Após revisão/exclusões, 269 amostras foram consideradas aproveitáveis: 110 abertas e 159 fechadas.
- Quatro rótulos foram identificados como trocados e 26 imagens não tiveram recorte Haar; os originais foram preservados.
- A inspeção apontou duas pessoas e cerca de três sessões. As abertas incluem uma pessoa/sessão; as fechadas incluem ambas as pessoas. O particionamento não isolou pessoas/sessões.
- Há correlação de captura: nitidez mediana Laplaciana 625 nas abertas versus 403 nas fechadas; brilho mediano 101 versus 114. É evidência de diferença entre condições, não prova de causalidade.
- Foram identificados muitos quadros semelhantes em sequência; agrupá-los por pHash reduz vazamento de quadros quase iguais, mas não o vazamento de identidade/sessão.

Na validação reconstruída com limiar 0,5, linhas = classe real e colunas = previsão (`aberto`, `fechado`):

| Pré-processamento V3 | n | Matriz | Acurácia | Recall fechado |
|---|---:|---|---:|---:|
| Recorte de treino em alta resolução | 59 | `[[24,0],[8,27]]` | 86,4% | 77,1% |
| Haar em quadro de 640 px | 59 | `[[24,0],[9,26]]` | 84,7% | 74,3% |
| Proxy FaceMesh, amostras disponíveis | 58 | `[[20,4],[0,34]]` | 93,1% | 100% |

O proxy FaceMesh não é a mesma implementação do FaceLandmarker do navegador; uma amostra fechada não foi detectada. As linhas não devem ser comparadas como modelos ou como estimativa de generalização. A validação foi usada no EarlyStopping; não é conjunto de teste independente. A avaliação Haar ainda deixou 9 de 35 imagens fechadas classificadas como abertas.

### Incidente reportado na webcam

O histórico informa 56/56 classificações como olhos fechados, com probabilidade 0,71–0,94 e EAR 0,185–0,347. Não há quadros, caixa, resolução efetiva ou log por amostra para replay. Logo:

- não é possível reconstruir matriz de confusão nem confirmar sincronização quadro a quadro;
- o EAR registrado pode indicar abertura intermediária, mas não substitui rótulo visual por quadro nem prova falha da CNN;
- a divergência de caixa foi comprovada em amostras do dataset, mas não pode ser declarada causa única das 56 previsões;
- iluminação, pessoa, enquadramento, escala, qualidade e diferença entre câmera de treino e runtime permanecem hipóteses não isoladas.

## 5. Verificação dos indicadores e do fluxo

- **V2:** o runtime do simulador usa as probabilidades das três classes e janela média de 2 s. O índice de risco existente usa `sonolento + 0,45 × bocejo`; políticas e limiares não foram modificados.
- **V3:** produz probabilidade binária de olhos fechados e usa o limiar existente de 0,5 apenas para exibição diagnóstica. Não alimenta o estimador, alertas ou intervenções.
- **MediaPipe:** a caixa é geométrica e normalizada. O EAR do painel é a média das medidas dos dois olhos; na integração principal, os EARs por lado seguem sendo calculados pelo scanner existente. EAR é uma métrica de abertura, não uma classificação de sonolência.
- **Média temporal:** as médias V2 são apresentadas separadamente das probabilidades instantâneas. A V3 permanece instantânea; não foi criada nova janela nem suavização.
- **Pré-processamento:** foi conferida a entrada RGB 0–255, o formato 160×160 e o intervalo/formato das saídas. Não foi encontrada necessidade de normalização externa adicional para a V3; a normalização está no próprio modelo.
- **Temporalidade:** o EAR do painel corresponde ao quadro entregue ao diagnóstico. Na integração principal existente, o EAR é derivado do resultado mais recente do MediaPipe e não carrega timestamp próprio; alinhamento exato com cada inferência CNN não é demonstrável pelos registros disponíveis.

## 6. Correções mínimas e preservação

1. Adicionada a V3 e os indicadores MediaPipe à interface diagnóstica e ao CSV.
2. Limitada a largura do quadro transmitido a 640 px, mantendo aspecto, para aproximar o caminho de entrada do runtime.
3. Convertidas as coordenadas Haar para inteiros Python antes da serialização JSON; o teste de integração reproduziu a falha com `numpy.int64` e confirmou a correção.
4. Falha de carga/inferência da V3 agora é exposta no diagnóstico sem interromper a comparação V2.
5. Teste de regressão confirma que o recorte V3 do painel coincide com `preparar_rosto_olhos()` do simulador quando recebe o mesmo quadro.

Não foram modificados os arquivos de pesos, dataset, servidor principal, política/limiares de alerta, métricas do scanner, código de intervenções, Arduino, FSR, simulador de condução ou regras existentes. Também não houve alteração de thresholds para fazer os exemplos passarem.

## 7. Validação executada e limitações

**Executado com sucesso**

- `py -3.12 -m pytest -q testes\simulador`: **10 passed**.
- Carga real V2/V3 e do cascade: entradas e quantidade de saídas esperadas; hashes conferidos.
- Inferência sintética: V2 produz vetor finito que soma aproximadamente 1; V3 produz probabilidade finita entre 0 e 1.
- Replay local dos dois exemplos Haar a 640×360: resultados acima.
- Layout HTML aberto no browser integrado: quatro painéis, controles e textos visíveis.

**Não executado / limitações**

- Node/npm não estão disponíveis; não foi possível executar os testes JavaScript do projeto nem um parser/linter JS local.
- A página não foi exercitada com câmera real e resposta WebSocket do comparador durante esta execução. A inspeção visual confirmou o layout, não a sessão completa de webcam.
- Na tentativa de recarregar a página estática para checar o módulo no browser, o pedido de `diagnostico-cnn.js` terminou em `ERR_EMPTY_RESPONSE`; a causa não foi isolada. A interface e os cartões renderizaram, mas a execução do JavaScript no browser não fica certificada por esta checagem.
- A CDN do FaceLandmarker requer acesso de rede no navegador.
- Não há os 56 quadros reais do incidente, nem teste independente por pessoa/sessão.
- A probabilidade depende da escala e do recorte; a conversão do browser para 640 px pode variar ligeiramente da redução OpenCV em pixel.
- Os exemplos de duas imagens e os testes sintéticos não estimam desempenho geral.
- O ambiente OpenCV é 5.0.0; a auditoria anterior registra OpenCV 4.11.0 no treinamento. Paridade do detector em todas as imagens não foi demonstrada.

Iniciador do painel: `INICIAR_COMPARADOR_CNN_V2.bat`. Endereço padrão: `http://localhost:8001/simulador/diagnostico-cnn.html`. É necessário que o caminho do modelo V2 configurado exista e que navegador/câmera/CDN estejam disponíveis. A V3 pode ser sobrescrita com `--modelo-olhos`; isso apenas seleciona o arquivo para inferência, não o modifica.

## CNN V4 — Necessidade e proposta

### Vale a pena criar outro modelo agora?

**Não com a evidência disponível, e não nesta execução.** Há uma divergência de integração já corrigida (detector/caixa e escala) e erros residuais, mas não existe replay dos quadros da webcam nem avaliação independente por pessoa/sessão. Um novo treino agora poderia repetir o viés de identidade, sessão, luz ou enquadramento do dataset e produzir uma aparente melhora sem generalização.

Primeiro deve-se executar o painel com rótulos humanos por etapa e registrar resultados, caixas, resolução, EAR, probabilidades e latência. Se o problema persistir em dados independentes depois de confirmar paridade de captura, então um novo modelo pode ser considerado.

### Problemas que uma V4 poderia endereçar

Se os testes demonstrarem que o erro restante é do modelo, uma versão futura poderia buscar:

- generalização entre pessoas, sessões, webcams, resoluções, iluminação, distância, pose e uso de óculos;
- melhor recall de olhos fechados sem degradar especificidade para olhos abertos;
- menor sensibilidade a fundo/cena e qualidade de imagem;
- calibração de probabilidades e comportamento consistente na webcam alvo.

Uma V4 **não** corrigiria por si só detector sem face, timestamps desalinhados, rótulos incorretos, métricas EAR inadequadas ou regras de alerta. Esses itens exigem correção/validação própria. Olhos fechados também não são rótulo equivalente a sonolência ou microssono.

### Dados e avaliação necessários antes de qualquer treino futuro

1. Novas sessões com muitas pessoas diferentes, sem que a mesma pessoa/sessão apareça simultaneamente em treino e teste.
2. Diversidade controlada de webcams, resolução/aspecto, iluminação, distância, ângulo, óculos e posições do rosto; incluir exemplos difíceis e quadros sem rosto.
3. Rótulos por quadro de `olhos_abertos`/`olhos_fechados`, com revisão humana e política explícita para piscadas, oclusão e exemplos ambíguos. Se o objetivo for sonolência, será necessário outro rótulo/ground truth temporal; olhos fechados não bastam.
4. Manifesto versionado de origem, pessoa, sessão, dispositivo e rótulo, mantendo dados de teste separados e sem vazamento de quadros contíguos.
5. Partições por pessoa/sessão: treino, validação para escolhas de época/limiar e teste final independente, sem reutilizar esse teste para ajustes.
6. Métricas por pessoa e condição: matriz de confusão, recall de olhos fechados, especificidade/precision de abertos, F1, calibração, falhas de detecção, latência e comparação com a V3 no mesmo replay.
7. Teste de operação em webcam antes de qualquer integração a alertas. Modelo, artefato e política só poderiam mudar mediante autorização explícita separada.

**Porta de autorização:** nenhum treino, geração ou integração de CNN V4 começa sem autorização explícita do usuário após a revisão deste relatório.
