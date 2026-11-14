# Relatório de diagnóstico — Projeto VIGIA / CNN

**Data da auditoria:** 11/11/2026  
**Escopo:** inspeção estática do projeto, configuração, notebook, ambiente disponível e arquivos de mídia/modelo. Nenhum modelo foi treinado ou salvo; nenhuma dependência foi instalada. O ambiente temporário criado pela seleção do Python foi removido.

## 1. Resumo executivo

- **Não foi encontrado nenhum modelo** com extensão `.keras`, `.h5`, `.hdf5`, `.tflite`, `.onnx` ou `.pt` na árvore do projeto, excluídos ambientes e dependências. `cnn_sonolencia.keras` e `cnn_sonolencia_v2.keras` não estão presentes. Portanto, não há tamanho, data de modificação ou SHA-256 a informar, nem foi possível carregar ou inspecionar uma CNN.
- O caminho configurado é `cnn_sonolencia.keras` na raiz (`config/analise.json:28`). No servidor, `--modelo` substitui esse caminho quando informado; sem o argumento, é usado o valor da configuração (`simulador/servidor.py:272,291`). Não há registro do comando usado em uma execução real, então não é possível determinar qual caminho foi usado fora deste checkout.
- O README documenta uma CNN chamada FaceCar_CNN_V2, MobileNetV2, 160×160 RGB e três saídas, mas isso não foi comprovado pelos pesos. O único notebook versionado descreve código rotulado como V1, com 96×96 e duas saídas; está sem execuções/resultados salvos e contém uma célula incompleta. Ele não comprova o treinamento da V2.
- O código de inferência implementa RGB, float32 em 0–255, redimensionamento quadrado e média temporal de 2 s. Isso coincide com o que o README documenta para a V2, **se** o modelo realmente tiver a normalização interna descrita. Sem pesos, essa compatibilidade não pode ser verificada.
- O README registra que o modelo então chamado `cnn_sonolencia_v2` teria produzido 75–98% de “sonolento” em um retrato acordado (`README.md:39`). É uma observação documentada, não reproduzida nesta auditoria.
- **Causa provável, mas não confirmada, da queda de desempenho:** diferença entre as imagens/dados de treinamento e a webcam de uso real (distribuição, enquadramento, iluminação e câmera). A observação do README é compatível com essa hipótese. Também pode haver problema de identidade/proveniência do artefato, mas não há hash ou histórico que demonstre troca.
- Para este checkout, a primeira ação é identificar e validar o arquivo de pesos pretendido, com hash e inspeção de entrada/saída, antes de avaliar ajustes de limiar ou retreinar.

## 2. Estrutura relevante do projeto

| Área | Conteúdo relacionado à auditoria |
|---|---|
| `config/` | Configuração da CNN, classes, janela temporal, câmeras e fusão. |
| `entrada/` | Inferência Python, preparação de quadros, fontes OpenCV e CLI. |
| `simulador/` | Servidor HTTP/WebSocket e cliente de webcam/CNN no navegador. |
| `treinamento/` | Apenas `modelo.ipynb`; não há scripts adicionais, dados, pesos ou registros de treino encontrados. |
| `testes/` | Testes unitários com modelos falsos e teste de carregamento real condicional à existência do `.keras`. |
| `.gitignore` | Ignora `*.keras` e dados/resultados de treinamento, o que explica a ausência possível no repositório, mas não identifica o arquivo que deveria estar implantado. |

Também foram procurados vídeos e imagens de teste. Não foram encontrados vídeos/imagens de rosto ou dataset; há apenas imagens estáticas de interface/cenário em `simulador/assets/`.

## 3. Tecnologias e versões identificadas

| Item | Evidência |
|---|---|
| Python disponível para a auditoria | 3.15.2. O projeto declara `>=3.12,<3.13` em `pyproject.toml`; o interpretador disponível está fora desse intervalo. |
| TensorFlow/Keras no ambiente disponível | Não instalados; não foi possível carregar o modelo. |
| OpenCV no ambiente disponível | 5.0.0. |
| NumPy no ambiente disponível | 2.5.4. |
| Versões resolvidas em `uv.lock` | TensorFlow 2.20.0 e Keras 3.15.1. São versões do lockfile, não prova de instalação ou uso na máquina de inferência. |
| Node/npm e pytest | Não disponíveis no PATH/ambiente consultado; os testes não foram executados. Não foram instalados. |

O projeto declara `tensorflow>=2.16,<2.21` e `requires-python >=3.12,<3.13`. A versão de Python disponível nesta auditoria não pode ser usada como evidência do ambiente onde o simulador é implantado.

## 4. Modelos encontrados e hashes

**Nenhum arquivo correspondente às extensões solicitadas foi encontrado.**

| Nome | Caminho absoluto | Tamanho | Última modificação | SHA-256 |
|---|---|---:|---|---|
| — | — | — | — | — |

Verificações específicas:

- `C:\face-car-master\cnn_sonolencia.keras`: ausente.
- `C:\face-car-master\cnn_sonolencia_v2.keras`: ausente.
- Também ausentes em `C:\face-car-master\modelos\`.
- Não foi encontrado outro arquivo de modelo com nome semelhante ou qualquer outro arquivo `.keras`, `.h5`, `.hdf5`, `.tflite`, `.onnx` ou `.pt` fora de ambientes/dependências.

Sem o arquivo, não é possível calcular hash, confirmar substituição, inspecionar arquitetura real ou atribuir o modelo a um treinamento.

## 5. Modelo usado pelo sistema e precedência de caminho

### Caminho pretendido pelo código

- A análise Python usa `RAIZ / config["classificador"]["modelo"]`, sem argumento `--modelo` próprio (`entrada/__main__.py:211-215`).
- O servidor do simulador constrói `ServicoCnn` com `args.modelo or RAIZ / analise["classificador"]["modelo"]` (`simulador/servidor.py:272`).
- Portanto, **no servidor, `--modelo` tem precedência**; sem ele, vale `config/analise.json`. Um `--modelo` relativo é interpretado relativamente ao diretório de trabalho do processo, pois é mantido como `Path` e passado diretamente ao carregador.
- O caminho padrão atual é `cnn_sonolencia.keras`, relativo à raiz. Se ausente, o servidor registra a CNN como indisponível e responde `cnn_indisponivel` (`simulador/servidor.py:172-180,224`). A página mostra o estado indisponível (`simulador/js/cnn.js:62-63,146`).

### Pode-se afirmar qual modelo está efetivamente carregado?

**Não.** Não havia modelo nesta árvore nem execução/log de servidor disponível. O código aponta para `cnn_sonolencia.keras` por padrão, mas isso não demonstra que um processo real usou esse caminho, que recebeu `--modelo`, nem que o arquivo externo eventualmente usado seja a V2 original.

Há divergência documental: `README.md:39` chama o modelo observado de `cnn_sonolencia_v2`, enquanto a configuração, o teste de carregamento e a seção de treinamento documentam `cnn_sonolencia.keras` (`config/analise.json:28`, `testes/entrada/test_classificador.py`, `README.md:326`). Isso é uma divergência de nome/caminho, **não evidência suficiente de renomeação ou substituição dos pesos**.

## 6. Inspeção interna da CNN

Não executada: faltam os pesos e TensorFlow/Keras não estão instalados no ambiente disponível. Assim, os itens abaixo são **descrições do README**, e não características verificadas do arquivo:

| Característica | Documentação encontrada | Estado do modelo real |
|---|---|---|
| Arquitetura | FaceCar_CNN_V2 baseada em MobileNetV2 (`README.md:209`) | Não inspecionado |
| Entrada | Quadro inteiro, RGB, 160×160 (`README.md:209-210`) | Não inspecionada |
| Valores de entrada | 0–255; normalização descrita como camada interna (`README.md:210`) | Não inspecionados |
| Saída | Três probabilidades, ordem alerta, sonolento, bocejo (`README.md:211-214`) | Não inspecionada |
| Ativação final | A documentação diz que as saídas são probabilidades que somam 1; não identifica a camada final real. | Não inspecionada |
| Camada de normalização | Descrita como interna no README. O notebook V1 tem `Rescaling(1./127.5, offset=-1)`, mas isso não prova a arquitetura V2. | Não inspecionada |
| Parâmetros/camadas principais | Não há resumo de execução ou arquivo de modelo disponível. | Não encontrados |
| Versões usadas no treinamento/inferência | O lockfile resolve TF 2.20.0/Keras 3.15.1; não há registro de que foram usadas no treino ou no runtime. | Não confirmadas |

O carregador chama `load_model(..., compile=False)`, lê o tamanho de entrada e compara apenas a quantidade de saídas com a lista configurada (`entrada/classificador.py:81-99`). A classificação verifica se a saída está entre 0 e 1 e soma aproximadamente 1, mas não verifica semanticamente a ordem/rótulos do arquivo (`entrada/classificador.py:65-75,107-113`).

## 7. Histórico de treinamento verificável

Todas as células de `treinamento/modelo.ipynb` têm `execution_count: null` e `outputs: []`; não há métricas ou resultados de execução salvos. A tabela descreve o código existente no notebook, não confirma que ele foi executado.

| Informação | Evidência no repositório | Classificação |
|---|---|---|
| Dataset V2 FL3D | Não há referência a FL3D no código/documentação pesquisada. O notebook usa genericamente `/content/dataset` (`modelo.ipynb:57-63`). | **NÃO ENCONTRADA** para V2 |
| 53.331 imagens; 48.327 treino; 3.317 validação; 1.687 teste | Não há contagens ou relatório de partições. Os números são apenas o histórico informado pelo usuário. | **DOCUMENTADA MAS NÃO VERIFICADA** (informação fornecida pelo usuário) |
| V2 com 3 classes | O README e o teste declaram três saídas e uma ordem pretendida; não há pesos/execução que comprovem isso (`README.md:211-214`, `test_classificador.py`, comentário perto da linha 75). | **DOCUMENTADA MAS NÃO VERIFICADA** |
| Notebook como treinamento V2 | O notebook rotula a matriz como “Face-Car V1” e o bloco de avaliação comenta “modelo V1” (`modelo.ipynb:270-313`). | **NÃO ENCONTRADA** |
| Dataset do notebook | `/content/dataset`, sem origem nem listagem de classes salva. | **DOCUMENTADA MAS NÃO VERIFICADA** |
| Dimensão do notebook | `image_size=(96,96)` e entrada MobileNetV2 `(96,96,3)` (`modelo.ipynb:61,110`). | **DOCUMENTADA MAS NÃO VERIFICADA**; não corresponde aos 160×160 informados para V2 |
| Classes do notebook | Camada final `Dense(2, softmax)` e relatório para `Drowsy`/`Non Drowsy` (`modelo.ipynb:123,291-313`). | **DOCUMENTADA MAS NÃO VERIFICADA**; não corresponde às três classes V2 |
| Divisão de dados do notebook | `validation_split=0.2`, `subset="both"`, `seed=42` e `batch_size=32` (`modelo.ipynb:59-68`). | **DOCUMENTADA MAS NÃO VERIFICADA** |
| Épocas / early stopping | Até 30 épocas; `EarlyStopping` em `val_loss`, paciência 4, restaurando melhores pesos (`modelo.ipynb:149-160`). Número efetivamente executado não existe. | **DOCUMENTADA MAS NÃO VERIFICADA** |
| Otimizador / learning rate | `optimizer="adam"` (`modelo.ipynb:127`); taxa não especificada. | Otimizador **DOCUMENTADO MAS NÃO VERIFICADO**; learning rate **NÃO ENCONTRADO** |
| Aumento de dados / fine-tuning | `RandomFlip`, `RandomRotation(0.06)`; base `trainable=False` (`modelo.ipynb:107-123`). | **DOCUMENTADA MAS NÃO VERIFICADA** no notebook; nenhum histórico V2 |
| Histórico de treinamento | Variável `hist` aparece no código, mas não há valores de `history` salvos. | **NÃO ENCONTRADO** |
| Matriz de confusão / métricas | Há código para calcular relatório/matriz para V1, sem saída, imagem versionada ou números reproduzíveis. | **DOCUMENTADA MAS NÃO VERIFICADA** para o notebook; V2 **NÃO ENCONTRADA** |
| Artefato final do notebook | O código salva `cnn_sonolencia.keras` no Google Drive (`modelo.ipynb:225`), e não `cnn_sonolencia_v2.keras`. | **DOCUMENTADA MAS NÃO VERIFICADA**; arquivo não está no projeto |
| 15 épocas, 90,46% acurácia, recall 90,39% bocejo e 65,24% microssono | Nenhuma evidência de código, log ou resultado salvo foi encontrada. | **DOCUMENTADA MAS NÃO VERIFICADA** (histórico informado pelo usuário) |

Há ainda uma célula incompleta (`x_treino =`) e referências a `x_full`/`y_full` sem definição no notebook (`modelo.ipynb:82-89`). O notebook não é, no estado encontrado, um registro autocontido e reproduzível do treino.

## 8. Fluxo da webcam até a interface

### Simulador (navegador)

1. `driver-monitor.js` abre a webcam pelo `getUserMedia`, com resolução ideal 640×480 (`driver-monitor.js:53-70`).
2. Com o scanner ativo, `ia.js` executa MediaPipe para determinar visibilidade do rosto; o CNN só recebe quadros quando `V.ia.ativo` e `rostoVisivel` (`ia.js:202-220`, `cnn.js:76-80`).
3. `cnn.js` desenha o quadro original do `<video>` em canvas quadrado do tamanho anunciado pelo servidor, lê os canais RGB e envia timestamp + pixels ao WebSocket `/cnn` (`cnn.js:86-99`).
4. `simulador/servidor.py` decodifica RGB, converte para float32 e chama `predict_on_batch`; as classes vêm da configuração e o servidor agrega probabilidades em `MediaTemporal` (`servidor.py:189-243`).
5. A resposta inclui probabilidades individuais e média. `cnn.js` atualiza painel e, se a resposta tiver menos de 800 ms e o motorista continuar visível, calcula o índice do simulador (`cnn.js:101-113`).
6. `ia.js` transforma esse índice e eventual bônus do volante na estimativa a cada 100 ms; a política gera mensagens que comandam apenas o veículo simulado (`ia.js:160-175`).

### Análise Python

1. `FonteWebcam` entrega quadros OpenCV em BGR (`entrada/fontes.py:52-95`).
2. `entrada/classificador.py` redimensiona para quadrado com `INTER_LINEAR`, converte BGR→RGB e converte para float32 sem alterar o intervalo 0–255 (`classificador.py:33-39`).
3. O modelo retorna o vetor; `argmax` é associado à lista de classes configurada. A média temporal descarta itens mais antigos que 2.000 ms (`classificador.py:107-139`).

### Compatibilidade e potenciais diferenças

- **Canais:** não há troca de canal evidente. OpenCV converte BGR→RGB; o navegador extrai R,G,B da imagem RGBA.
- **Dimensão/enquadramento:** ambos redimensionam o quadro inteiro para uma imagem quadrada, sem recorte. Em 640×480 isso deforma a proporção 4:3 para 1:1, embora a mesma ideia exista nos dois fluxos. A interpolação do canvas do navegador não é garantidamente idêntica à `INTER_LINEAR` do OpenCV.
- **Fontes de câmera:** não são necessariamente a mesma câmera nem o mesmo backend. O navegador escolhe a câmera com `facingMode: user`; a CLI Python usa dispositivos configurados em `/dev/v4l/by-path/` ou a descoberta Linux em `/sys/class/video4linux` (`config/analise.json:13-22`, `entrada/fontes.py`). Em Windows, essa configuração Linux não identifica por si só uma webcam OpenCV local.
- **Infravermelho:** uma câmera IR real produz distribuição/cor diferente da RGB descrita para o treino. O filtro monocromático alternativo é visual; a captura enviada ao CNN é feita do elemento de vídeo, não do canvas de desenho da sobreposição.
- **Normalização:** os dois clientes fornecem pixels 0–255 e o servidor apenas converte o tipo numérico. Não há normalização externa duplicada visível. A conclusão de que isso é correto depende de a camada interna descrita no README existir nos pesos carregados.
- **Ordem das classes:** `config/analise.json` e um teste unitário afirmam `alerta`, `sonolento`, `bocejo`, que coincide com a ordem documentada para a V2. O programa verifica número de saídas, não valida rótulos internos; pesos de três classes com outra ordem seriam associados a nomes errados sem falha de dimensão.
- **Probabilidades:** `argmax` seleciona a classe e o dicionário associa os índices aos nomes configurados. Python rejeita valores fora de 0–1 ou soma distante de 1. A ativação real não foi inspecionada.
- **Média de dois segundos:** implementada na análise Python e no servidor; a configuração é 2.000 ms. No navegador, o envio ocorre a cada 125 ms (até 8 q/s), uma requisição por vez. Portanto, o código de janela funciona conforme projetado; disponibilidade contínua e taxa real ainda dependem da webcam e latência.
- **Limiar/fusão:** no simulador, o índice é `100 × (p_sonolento + 0,45 × p_bocejo)`, e há política com faixas 25/35/45/65 e bônus do volante (`cnn.js:108-113`, `config/estimador.json`). Isso altera o estado de alerta/intervenção, não as probabilidades brutas mostradas pelo CNN. Não explica, por si só, uma queda de acurácia da rede.
- **Fallback/simulação:** com CNN indisponível ou sem resultado fresco, `ia.js` marca `sem_cnn`; a política fica sem evidência válida/degradada. Se o scanner não estiver ativo, `driver-monitor.js` gera métricas simuladas a partir do nível do simulador e exibe “MÉTRICAS SIMULADAS” (`driver-monitor.js:361-402`). Ver a animação ou indicadores sem scanner ativo não comprova que houve inferência CNN.

## 9. Problemas e evidências

| Prioridade | Arquivo/linhas | Evidência | Impacto |
|---|---|---|---|
| Alta — bloqueador neste checkout | `config/analise.json:28`; `entrada/__main__.py:211-215`; `simulador/servidor.py:172-180,224,272` | Configuração aponta a um arquivo ausente; servidor reporta CNN indisponível se não o encontrar. | Este checkout não pode demonstrar inferência CNN efetiva; no modo do servidor, o painel deve indicar indisponibilidade/degradação. |
| Alta — proveniência desconhecida | `README.md:39,209-214,326`; `config/analise.json:28`; `.gitignore` | V2 é citada em documentação, mas o artefato é ignorado/ausente e o nome documentado varia. Não há hash histórico. | Não se pode provar que o arquivo implantado é a V2 original nem detectar alteração/substituição. |
| Alta — treino não rastreável | `treinamento/modelo.ipynb:57-160,225-315` | Notebook sem execução/outputs, V1, duas saídas, 96×96, ausência de origem FL3D e célula incompleta. | Métricas do prompt e arquitetura V2 não podem ser auditadas ou reproduzidas a partir do material versionado. |
| Média — associação de classe não autenticada | `entrada/classificador.py:81-88,107-113`; `config/analise.json:29-34`; `testes/entrada/test_classificador.py` | Checa apenas quantidade de saídas; ordem é uma convenção do config/teste. | Pesos de três classes em ordem semântica diferente poderiam produzir rótulos errados sem erro de carregamento. Não há evidência de que isso ocorreu. |
| Média — preprocessamento depende do artefato | `entrada/classificador.py:33-39`; `simulador/js/cnn.js:86-99`; `simulador/servidor.py:189-202`; `README.md:209-214` | Código fornece RGB 0–255; normalização interna é apenas documentada. | Se os pesos externos tiverem escala/camada de entrada diferente, poderá haver normalização ausente ou dupla. Não verificável sem o modelo. |
| Média — diferença de domínio de imagem | `config/analise.json:13-22`; `simulador/js/cnn.js:86-99`; `entrada/fontes.py`; `README.md:39` | Webcam browser/OpenCV, enquadramento, iluminação e possível câmera IR não são garantidamente equivalentes ao dataset. README registra uma previsão alta de sonolência em retrato acordado. | Pode degradar generalização e calibragem em operação; ainda é hipótese, não causa comprovada. |
| Média — simulador pode ser confundido com inferência real | `simulador/js/driver-monitor.js:361-402`; `simulador/js/ia.js:165-175`; `simulador/js/cnn.js:62-63,144-146` | Scanner desligado usa métricas simuladas; CNN indisponível é explicitamente tratada como tal e degrada a política. | Uma demonstração visual pode parecer ativa sem CNN. A UI tem estados para distinguir, mas precisa-se conferir o estado do scanner/modelo durante a avaliação. |
| Baixa — diferença de amostragem/resampling | `entrada/classificador.py:38`; `simulador/js/cnn.js:91` | OpenCV usa `INTER_LINEAR`; canvas do navegador tem caminho de redimensionamento próprio; ambos achatam 4:3 em quadrado. | Pode produzir diferença pequena entre aplicações; não há teste pareado que meça o efeito. |

## 10. Hipóteses para a queda de desempenho, em ordem de prioridade

1. **Mudança de domínio entre FL3D/treino e webcam real.** É a hipótese mais provável entre as causas estatísticas porque as câmeras e condições de captura variam, o modelo é aplicado ao quadro inteiro e o README documenta um exemplo de forte probabilidade “sonolento” em retrato acordado. O exemplo e o dataset não estão disponíveis para validação.
2. **Identidade/proveniência do arquivo implantado não comprovada.** O checkout não tem pesos e os nomes `cnn_sonolencia.keras` e `cnn_sonolencia_v2` são usados de forma diferente na documentação. Isso pode explicar uma instalação concreta, mas não há evidência de que houve troca.
3. **Pré-processamento/assinatura de entrada diferente nos pesos externos.** O cliente e o servidor têm caminho coerente para RGB 0–255; o risco está em supor que pesos não inspecionados contenham a normalização esperada.
4. **Rótulos de saída diferentes dos rótulos configurados.** O config coincide com a ordem pretendida nos testes e no README; portanto, não há indício atual de troca de classes. O artefato ausente impede confirmar a ordem real.
5. **Limitações do treino, sobreajuste/calibragem ou avaliação não comparável.** O notebook rastreado não comprova o V2 nem as métricas reportadas; sem split, pesos e relatório histórico, não é possível separar limitação original de integração.
6. **Regras de integração/limiares.** Podem mudar o nível de alerta do simulador, mas não modificam a predição bruta que alimenta o painel/CSV; são menos prováveis para explicar queda de classificação da CNN.

Não se conclui que o modelo foi trocado apenas porque há desempenho pior. Para o checkout atual, a conclusão objetiva é ausência do artefato e impossibilidade de validar a identidade.

## 11. Melhorias recomendadas (sem alterações nesta auditoria)

1. Recuperar o artefato de origem autorizado e registrar SHA-256, data, origem e caminho de implantação. Compará-lo com qualquer cópia de produção; não renomear ou salvar novamente antes de preservar a evidência.
2. Carregar somente em ambiente compatível já aprovado e registrar: `model.summary()`, shapes, classes/ordem mantidas junto ao modelo, camada final, normalização, parâmetros e versões de TF/Keras. Confirmar que entrada é RGB float32 0–255.
3. Tornar a classe de cada índice parte do contrato versionado do artefato e validar o contrato no startup, não apenas a quantidade de saídas.
4. Rodar predições pareadas com o mesmo arquivo de vídeo/quadros, mesmo tamanho e mesmo modelo através do caminho OpenCV e do navegador. Comparar pixels de entrada e probabilidades, separando diferença de resize da diferença de captura.
5. Avaliar com conjunto de teste rotulado e representativo da webcam, separado por pessoa/sessão; publicar matriz de confusão, recall por classe, precisão, F1 e calibração. Não reutilizar o teste para escolher limiares.
6. Conferir o estado “CNN pronto”, scanner ativo, versão/hash e taxa de inferência em cada execução. Não tomar métricas simuladas ou modo degradado como resultado do modelo.
7. Testar RGB e IR separadamente. Não armazenar capturas de webcam sem necessidade; preferir vídeos de teste existentes/autorizados e manter as mesmas entradas apenas durante a comparação.

## 12. Testes para confirmar ou descartar hipóteses

| Hipótese | Teste reproduzível necessário |
|---|---|
| Arquivo errado/substituído | Comparar SHA-256 do arquivo implantado com uma cópia V2 de procedência conhecida; inspecionar logs/argumentos de inicialização e o caminho efetivo. Sem hash de referência não é possível provar alteração passada. |
| Ordem de classes | Validar metadados do treino/artefato e usar um conjunto pequeno, rotulado e controlado de cada classe; comparar índice bruto com nome exibido em Python e navegador. |
| Pré-processamento | Aplicar o mesmo quadro RGB ao modelo diretamente e aos dois pipelines; comparar tensor após resize/conversão e vetor de probabilidades. Confirmar faixa antes e depois da camada de normalização. |
| Mudança de código | Comparar versões históricas do classificador/config/integrador; Git não está disponível neste checkout, então será necessário obter o repositório/commits correspondentes. |
| Iluminação/câmera/distribuição | Avaliar por câmera, iluminação, distância, enquadramento e RGB/IR em exemplos rotulados, mantendo o mesmo modelo e protocolo. |
| Limitação do treino | Recuperar dataset/splits, logs e pesos; reproduzir métricas no teste reservado e comparar por classe e por pessoa. |
| Integração do simulador | Exportar o CSV de leituras CNN (probabilidades brutas/média/índice) com scanner e modelo confirmados como ativos; confrontar o mesmo vídeo com a análise Python. |

Não foram encontrados vídeos ou amostras de rosto no projeto para executar essa comparação agora. Não foram usadas nem armazenadas capturas da webcam.

## 13. Histórico Git e informações faltantes

- `C:\face-car-master` não é um repositório Git (`git rev-parse` retorna “not a git repository”). Não há commits locais a consultar sobre carregamento, caminhos, pré-processamento, classes ou integração.
- Faltam: arquivo `.keras` original e cópia atualmente implantada; SHA-256 de referência; comando/argumentos/logs do servidor real; metadados de classe serializados; notebook/script V2 executado; dataset e manifestos dos splits; histórico de treino; relatório/matriz de confusão; entradas rotuladas usadas para observar a queda; identificação da câmera/condições; versão do ambiente de produção.
- A auditoria não conseguiu inspecionar a arquitetura, ativação, normalização, parâmetros ou probabilidades do arquivo real porque o arquivo e TensorFlow/Keras não estavam disponíveis.

## Respostas finais

**O modelo usado atualmente é comprovadamente a CNN V2 original?**  
**Não.** O checkout não contém pesos nem hash, e não há execução registrada que identifique o arquivo efetivamente carregado.

**Existe evidência de alteração ou substituição do arquivo `.keras`?**  
**Não.** Há divergência de nomes e o arquivo está ausente/ignorado, mas não há hash ou histórico Git que demonstre alteração ou substituição.

**Qual é a causa mais provável da queda de desempenho?**  
**Provisoriamente, mudança de domínio entre treino e webcam real** (câmera, enquadramento, iluminação e/ou IR), coerente com a observação não reproduzida no README de alta probabilidade de sonolência em uma imagem acordada. A causa não pode ser confirmada sem o artefato e entradas de teste rotuladas.

**O que devemos corrigir primeiro?**  
**Primeiro, estabelecer a identidade do modelo implantado:** localizar uma cópia de procedência conhecida, registrar o hash e inspecionar entrada, normalização, saída e ordem das classes. Depois executar comparação pareada com as mesmas imagens e validação rotulada. Não há base para alterar limiares ou retreinar antes dessas verificações.
