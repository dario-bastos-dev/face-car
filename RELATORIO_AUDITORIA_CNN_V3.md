# Auditoria da CNN de olhos V3 — VIGIA

**Data:** 12/11/2026  
**Decisão:** corrigida a entrada da V3 para aproximá-la do treinamento; modelo permanece experimental e observacional. Não houve novo treinamento.

## 1. Resumo executivo

O problema de pré-processamento mais bem comprovado não era a escala RGB nem uma normalização duplicada: a V3 recebia um recorte delimitado pelos pontos do MediaPipe, enquanto foi treinada com uma caixa do Haar Cascade. Um teste pareado no mesmo conjunto mostrou que essa diferença de caixa pode elevar substancialmente a probabilidade de “olhos fechados”. Para `olhos_abertos/foto_0071.jpg`, por exemplo, a probabilidade foi 0,305 no recorte de treino, 0,465 no recorte Haar de 640 px e 0,869 no recorte de um proxy FaceMesh.

Corrigi somente a preparação da entrada da V3: ela agora detecta o rosto com o mesmo Haar Cascade do treinamento e usa a margem de 8%. A V2, seu recorte, o MediaPipe, o EAR, alertas, métricas e controles não foram alterados. O falso positivo de `foto_0071.jpg` desapareceu no teste rápido com o código corrigido; um falso negativo (`olhos_fechados/foto_0044.jpg`) permaneceu. Portanto, a divergência de recorte é uma causa comprovada de erros da V3, mas **não há evidência suficiente para afirmar que explica sozinha as 56/56 classificações como fechadas na webcam**: os quadros/logs dessas 56 amostras não foram fornecidos.

**Conclusão:** a V3 ainda não está pronta para controlar o VIGIA. Não foi treinada uma nova versão. Deve continuar apenas em observação até uma avaliação independente com várias pessoas, sessões e a webcam real.

## 2. Problemas encontrados por gravidade

| Gravidade | Achado | Evidência / situação |
|---|---|---|
| Alta | Divergência entre a caixa de treino (Haar) e a caixa anterior de inferência (MediaPipe) | O proxy FaceMesh elevou `foto_0071.jpg` de 0,305 para 0,869 em probabilidade de olhos fechados. **Corrigido na entrada da V3**; a inferência agora usa Haar. |
| Alta | Não existe avaliação independente nem replay dos 56 quadros da webcam | Só foram fornecidas a contagem 56/56, a faixa de probabilidade 0,71–0,94 e EAR 0,185–0,347. Não há imagens/log por amostra para reproduzir métricas ou associar quadro e EAR. |
| Alta | Treino/validação não separam pessoas ou sessões | O split agrupou imagens próximas, mas pessoas e sessões aparecem nos dois lados; a validação também foi usada no EarlyStopping. |
| Média | Rótulos e detecção facial problemáticos | Quatro rótulos foram corrigidos na revisão; Haar não encontrou recorte comparável em 26 fotos. Falha do detector não significa que a foto esteja corrompida. |
| Média | Viés de pessoa, cena, nitidez e iluminação | Há duas pessoas identificáveis e três sessões aproximadas; olhos abertos aparecem em uma pessoa, enquanto fechados incluem ambas. As distribuições de nitidez e brilho também diferem entre pastas. |
| Média | Falsos negativos de olhos fechados continuam | Na validação reconstruída com o recorte Haar de 640 px, 9/35 imagens fechadas foram previstas como abertas. `foto_0044.jpg` também permaneceu abaixo do limiar após a correção. |

## 3. Inventário e qualidade do dataset

Dataset original: `C:\data set propio\data set propio\2_olhos`.

| Pasta original | Fotos | Haar encontrou rosto | Rótulo revisto / aproveitável no split anterior |
|---|---:|---:|---:|
| `olhos_abertos` | 118 | 113 | 110 abertas |
| `olhos_fechados` | 181 | 160 | 159 fechadas |
| **Total** | **299** | **273** | **269** |

- Todas as 299 fotos são JPEG de 1280×720 e foram decodificadas; não foi detectado arquivo corrompido.
- Haar não encontrou rosto em 5 fotos de `olhos_abertos` e 21 de `olhos_fechados`. Elas não foram usadas no treino anterior, pois não havia um recorte reproduzível por aquele pipeline.
- Quatro rótulos claramente trocados na revisão visual: `olhos_abertos/foto_0035.jpg`, `foto_0063.jpg` e `foto_0099.jpg` mostram olhos fechados; `olhos_fechados/foto_0001.jpg` mostra olhos abertos. Os originais não foram alterados. Esses quatro casos foram excluídos do treino anterior, não relabelados dentro do modelo.
- Após essas exclusões, há 110 abertas e 159 fechadas (59,1% fechadas). É um desequilíbrio moderado, insuficiente por si só para demonstrar a origem de 56/56 previsões fechadas.
- Na métrica de nitidez Laplaciana dos recortes faciais: mediana 625 nas abertas e 403 nas fechadas. Brilho médio em escala de cinza: mediana 101 nas abertas e 114 nas fechadas. Isso evidencia diferenças de captura correlacionadas ao rótulo, não prova que sejam a causa de um erro específico.

### Semelhança, sequência e pessoas

Foi calculado pHash de 63 bits nos recortes Haar; pares com distância de Hamming ≤4 foram agrupados sem apagar imagens:

- Abertas: 48 pares próximos, 75 grupos; o maior grupo conectado tem 22 fotos.
- Fechadas: 188 pares próximos, 102 grupos; o maior grupo conectado tem 43 fotos.
- Não houve par próximo entre classes diferentes nem par ≤4 atravessando o split reconstruído. Esses grupos reduzem vazamento de quadros quase iguais, mas **não** evitam vazamento por pessoa ou sessão.

Pela inspeção visual e pelos horários dos arquivos, as abertas são uma sessão de cerca de 1,98 min com o homem de camiseta amarela. As fechadas abrangem cerca de 11,37 min: o homem de camiseta amarela aparece até `foto_0128.jpg`; após uma pausa de aproximadamente 500 s, `foto_0129.jpg` inicia uma sequência com outro homem, de camiseta preta. Assim, há duas pessoas e três sessões aproximadas. As duas pessoas aparecem na classe fechada, mas só uma aparece na classe aberta. O split anterior colocou amostras das mesmas pessoas/sessões em treino e validação.

## 4. Auditoria do modelo

- **V2:** entrada `(160, 160, 3)`, três saídas, classe na ordem configurada `alerta`, `sonolento`, `bocejo`. Não possui uma saída específica “olhos abertos/fechados”, então não é possível comparar diretamente sua acurácia binária com a V3.
- **V3 atual:** entrada RGB `(160, 160, 3)`, uma saída sigmoid (`olhos_fechados`), limiar 0,5. A base é MobileNetV2; há 880.321 parâmetros treináveis e 1.378.944 não treináveis.
- A camada interna `Rescaling` aplica `x / 127,5 − 1`. O treinamento e o servidor fornecem pixels RGB na faixa 0–255; o servidor não normaliza antes da inferência. **Não foi encontrado erro de faixa RGB ou normalização duplicada.**
- O treino anterior usou primeiro a base congelada por 3 épocas a `5e-4`, depois descongelou as últimas camadas não-BatchNorm por até 3 épocas a `1e-5`, com EarlyStopping (paciência 1). O histórico por época e o manifesto original treino/validação não foram persistidos; por isso, a auditoria não consegue reconstituir curvas de loss nem provar exatamente cada membership do split.
- Hashes verificados nesta auditoria: V2 `c87f4d6e362c399b15d1960ce841290c11f006c5cabcde856ca088f18cac00c6`; V3 `bab4ccec941f6bf2c423a403d090e2e15396919af3d1a3c89359b4db52ab7f4f`.

## 5. Avaliação controlada e métricas

As probabilidades são de `olhos_fechados`; limiar fixo 0,5. Matrizes usam **linhas = classe real** e **colunas = prevista**, na ordem aberta/fechada. A validação foi reconstruída pelo agrupamento pHash e reproduziu 86/124 amostras de treino e 24/35 de validação. Como essa validação foi usada no EarlyStopping e não separa pessoas/sessões, os resultados abaixo são **diagnósticos reutilizados, não teste independente**.

| Entrada da V3 | n | Matriz | Acurácia | Abertos: precision / recall / F1 | Fechados: precision / recall / F1 |
|---|---:|---|---:|---|---|
| Recorte de treino (alta resolução), validação reconstruída | 59 | `[[24,0],[8,27]]` | 86,4% | 75,0% / 100% / 85,7% | 100% / 77,1% / 87,1% |
| Haar em quadro 640 px, mesma validação | 59 | `[[24,0],[9,26]]` | 84,7% | 72,7% / 100% / 84,2% | 100% / 74,3% / 85,2% |
| Proxy MediaPipe FaceMesh, mesma validação disponível | 58 | `[[20,4],[0,34]]` | 93,1% | 100% / 83,3% / 90,9% | 89,5% / 100% / 94,4% |

O proxy FaceMesh não é replay exato do FaceLandmarker usado pelo navegador; uma amostra fechada não teve face detectada e ficou fora dessa linha. Portanto, não compare essas linhas como se fossem modelos distintos nem interprete a maior acurácia do proxy como evidência de melhor generalização.

No treino reconstruído com o recorte de treino, a acurácia foi 91,9% (matriz `[[85,1],[16,108]]`), cerca de 5,5 pontos acima da validação. Esse gap pode sinalizar ajuste excessivo, mas não permite concluir overfitting: o conjunto é pequeno, a validação não é independente e o histórico de treino não foi salvo.

Na validação reconstruída, a probabilidade de fechados no proxy FaceMesh provocou 4/24 falsos positivos em olhos abertos; com o Haar de 640 px foram 0/24. No mesmo proxy, a mediana de probabilidade das 110 amostras abertas elegíveis subiu de 0,058 no recorte de treino para aproximadamente 0,331 no recorte FaceMesh, e 10/110 cruzaram 0,5. Isso sustenta a divergência geométrica como causa de falsos fechados. Por outro lado, no recorte Haar de 640 px houve 9/35 falsos negativos de olhos fechados.

Uma amostra concreta: `olhos_abertos/foto_0071.jpg` é visualmente aberta; teve 0,305 no recorte de treino, 0,465 no proxy Haar em 640 px e 0,869 no proxy FaceMesh. O falso negativo `olhos_fechados/foto_0044.jpg` teve 0,445 no código corrigido e continuou previsto como aberto. Isso mostra que a correção de integração ajuda, mas não torna o modelo confiável.

## 6. Comparação entre treino e webcam

| Item | Treinamento anterior | Integração anterior | Estado após correção |
|---|---|---|---|
| Detector/caixa facial | Haar Cascade em imagem reduzida a 640×360; maior face | Caixa pelos pontos do MediaPipe | A V3 voltou a usar Haar; MediaPipe continua para EAR e processamento existente |
| Margem | 8% | 8% sobre uma caixa diferente | 8% |
| Recorte/redimensionamento | Caixa projetada para o original e redimensionada para 160×160 | Recorte do quadro transportado, 160×160 | Recorte Haar no quadro atual, 160×160 |
| Cor/faixa/normalização | RGB, 0–255, normalização interna | RGB, 0–255, sem normalização externa | Mantidos |
| Resolução | Fotos 1280×720; caixa detectada a 640×360 | Quadro enviado pelo navegador limitado a 640 px de largura; a configuração RGB do projeto indica 640×480 | Continua limitado a 640 px; o teste pareado mostrou impacto menor que o da caixa |
| Alinhamento | — | V3 e V2 usam o quadro atual; o EAR é a leitura MediaPipe mais recente, sem timestamp próprio | Não foi observado resultado V3 antigo; alinhamento temporal exato do EAR permanece não comprovado |

Com a caixa Haar fixa, reduzir o recorte de 1280 para 640 px alterou a validação de 8 para 9 falsos negativos fechados, com acurácia de 86,4% para 84,7%. Isso pode afetar amostras individuais, mas não reproduz o colapso da webcam. A caixa do MediaPipe, em contraste, deslocou fortemente algumas probabilidades. As 56 capturas reais não estão disponíveis para testar se esse fator, a posição/escala do rosto, a iluminação, a pessoa ou a câmera explicam o restante.

O navegador mantém apenas uma inferência CNN em trânsito e o servidor usa o quadro RGB recebido para V2 e V3; não há evidência de quadro antigo alimentando a V3. O EAR é obtido do último resultado MediaPipe sem timestamp transmitido junto, então sua correspondência quadro a quadro não pode ser garantida.

## 7. Correção realizada e preservação

1. `simulador/servidor.py`: apenas a entrada da V3 passou a detectar a maior face com Haar, aplicar margem de 8% e gerar o recorte RGB 160×160. Se Haar não detectar rosto, a V3 não produz leitura naquele quadro. O campo de diagnóstico da V3 identifica esse pré-processamento.
2. `simulador/haarcascade_frontalface_default.xml`: incluído o cascade usado no ambiente de treinamento para que a execução Python 3.12 do iniciador tenha o mesmo recurso, mesmo quando `cv2.data` não o fornece.
3. `README.md`: documentação do recorte Haar e do comportamento quando não há detecção.
4. Backup do código feito antes da edição: `.vigia-cnn-v3-audit-backup-20261112/servidor.py`.

Não foram alterados `cnn_olhos_v3.keras`, a V2 original, `cnn.js`, `ia.js`, configuração, interface, MediaPipe, EAR, métricas, alertas, Arduino, FSR ou controles. Nenhum modelo foi treinado. As imagens de origem continuam intactas; os dois exemplos abaixo são cópias.

## 8. Verificação curta após a correção

Executado no Python 3.12.10 do iniciador, com OpenCV 5.0.0:

- Cascade carregou (`empty=False`), V3 carregou com entrada `(160,160,3)` e saída sigmoid.
- `foto_0071.jpg`: recorte `uint8 (160,160,3)`, probabilidade 0,46452, decisão aberta; antes, o proxy FaceMesh dava 0,86895 e decisão fechada.
- `foto_0044.jpg`: recorte `uint8 (160,160,3)`, probabilidade 0,44538, decisão aberta — falso negativo ainda presente.
- O caso sem rosto retornou ausência de recorte, sem interromper a V2.
- Hashes da V2 e V3 permaneceram iguais aos acima.

Esse smoke test comprova carga, recorte e inferência; não é avaliação de desempenho em tempo real. O OpenCV usado no treino era 4.11.0 e o iniciador aqui usa 5.0.0; os dois exemplos produziram as probabilidades esperadas, mas a paridade do detector em todas as imagens não foi verificada.

## 9. Inventário por amostra e exemplos

O CSV [`saidas/cnn_v3_auditoria_amostras.csv`](saidas/cnn_v3_auditoria_amostras.csv) contém uma linha para cada uma das 299 imagens: rótulo de pasta e revisto, motivo de revisão, disponibilidade de Haar/FaceMesh, split reconstruído, probabilidades por tipo de recorte, previsão/acerto, nitidez, área facial e horário. Os 26 caminhos sem recorte Haar e os quatro rótulos revistos estão identificados nele.

Cópias de exemplos, sem alterar os originais:

- [`saidas/diagnostico_cnn_v3_20261112/falso_positivo_fechado_foto_0071.jpg`](saidas/diagnostico_cnn_v3_20261112/falso_positivo_fechado_foto_0071.jpg): olhos abertos; falso fechado no proxy FaceMesh (0,869).
- [`saidas/diagnostico_cnn_v3_20261112/falso_negativo_aberto_foto_0044.jpg`](saidas/diagnostico_cnn_v3_20261112/falso_negativo_aberto_foto_0044.jpg): olhos fechados; previsto aberto no recorte Haar pós-correção (0,445).

## 10. Limitações que permanecem

- Sem as 56 imagens/logs reais, não há matriz de confusão nem causa única comprovada para o resultado da webcam.
- Não existe teste independente por pessoa/sessão; as métricas da validação foram usadas durante a escolha de épocas.
- Dataset curto, cenário quase único e apenas duas pessoas; a sensibilidade a iluminação, posição, distância e diferentes webcams não foi medida de forma controlada.
- As fotos são 16:9 (1280×720), enquanto a configuração RGB do projeto pede 640×480; a resolução/aspecto efetivos do quadro do navegador não foram registrados nesta auditoria.
- Uma única falha de face ocorreu no proxy FaceMesh; 26 fotos não tiveram detecção Haar no fluxo comparável ao treino.
- Não há log de loss por época nem manifesto original de split.
- A V2 reconhece categorias diferentes; não é possível afirmar que V2 é melhor ou pior na tarefa binária de olhos.
- Olhos fechados não significam automaticamente microssono ou sonolência.

## 11. Recomendações prioritárias

1. Manter a V3 somente em observação. Não conectá-la a alerta, intervenção ou decisão do simulador.
2. Registrar, numa coleta controlada, imagem/frame, caixa Haar usada pela V3, probabilidade V3, probabilidades V2, EAR e timestamp correspondente; revisar manualmente amostras abertas/fechadas e erros.
3. Ampliar o dataset com várias pessoas, sessões, posições, iluminação e a mesma câmera/resolução de execução. Rotular estado dos olhos, não sonolência.
4. Separar treino/validação/teste por pessoa ou sessão antes de qualquer novo treinamento; reservar teste que não participe do EarlyStopping nem da escolha de limiar.
5. Se o problema persistir após essa coleta, planejar no máximo um treinamento corretivo com recortes e detector idênticos ao runtime. Não escolher limiar com os mesmos dados usados para avaliar.

## 12. Prontidão e decisão

**Status: experimental; não pronto para integração operacional.** A correção remove uma divergência real da entrada e resolveu o falso positivo controlado de `foto_0071.jpg`, mas há falso negativo persistente, validação contaminada por pessoa/sessão e nenhuma reprodução independente da webcam. A V3 continua desacoplada dos alertas.

Para observar: execute `INICIAR_VIGIA_V2.bat --diagnostico-cnn` e abra `http://localhost:8000/simulador/?cnnModo=rosto`. As linhas `[CNN_DIAG]` mostram V2, decisão/probabilidade da V3, EAR e estado do recorte; a V3 não comanda intervenções.

## 13. Resumo em linguagem simples

O modelo não estava recebendo exatamente o mesmo enquadramento do rosto que recebeu no treinamento. O recorte do MediaPipe podia fazer uma foto com olhos abertos parecer fechada para a V3. Ajustei apenas essa entrada para usar o detector Haar do treinamento. O teste rápido confirmou que um falso positivo conhecido deixou de ocorrer, mas um falso negativo continuou; portanto, a correção não prova que o problema da webcam acabou. As fotos são poucas e repetem pessoas, cenário e sessões, e a validação não é independente. Não houve novo treino nem alteração da CNN V2. A V3 deve continuar experimental até ser avaliada com dados reais de várias pessoas e sessões.
