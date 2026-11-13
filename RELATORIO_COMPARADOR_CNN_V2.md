# Diagnóstico visual CNN V2, CNN V3 e MediaPipe

## Implementação

O painel é independente do simulador principal. Captura um único quadro da webcam, reduz a largura a no máximo 640 px (preservando a proporção) e envia pixels RGB; o FaceLandmarker usa o vídeo da câmera e gera caixa/EAR no mesmo ciclo:

- **QUADRO INTEIRO**: `cv2.resize` do quadro completo para 160×160.
- **V2 · ROSTO RECORTADO**: reprodução de `preparar_rosto()` de `camera_v2.py`, com margem de 20%, RGB, preservação de proporção e padding preto.
- **CNN V3 · OLHOS**: probabilidade de olhos fechados, decisão com o limiar existente de 0,5, latência e caixa. Usa o mesmo quadro de até 640 px, Haar Cascade, margem de 8%, RGB 160×160 e `INTER_AREA` do runtime da V3. A V3 permanece observacional.
- **MediaPipe**: detecção facial, caixa normalizada e EAR, exibidos como medidas geométricas independentes da CNN.

V2 e V3 são carregadas uma única vez; a V2 valida seu SHA-256 esperado e a V3 expõe seu hash/entrada/saída no handshake. Se a V3 ou o cascade estiverem indisponíveis, o painel informa o motivo e mantém a comparação V2 ativa.

## Arquivos

- `simulador/diagnostico_cnn.py`: servidor HTTP/WebSocket independente.
- `simulador/diagnostico-cnn.html`: página visual de diagnóstico.
- `simulador/js/diagnostico-cnn.js`: captura única, FaceLandmarker, visualização e exportação CSV.
- `testes/simulador/test_diagnostico_cnn.py`: testes dos preprocessamentos, paridade da V3 com o runtime e campos do diagnóstico.
- `INICIAR_COMPARADOR_CNN_V2.bat`: inicializador com Python 3.12.

Nenhum arquivo do fluxo principal foi alterado nesta etapa.

## Como iniciar

Na raiz do projeto:

```text
INICIAR_COMPARADOR_CNN_V2.bat
```

Depois abrir:

`http://localhost:8001/simulador/diagnostico-cnn.html`

O servidor pode receber `--http` e `--ws` para alterar as portas.

## Dados registrados

Os dois modos V2 exibem probabilidades instantâneas, classe, tempo de inferência e médias temporais separadas. O painel V3 mostra probabilidade, decisão, estado/erro do recorte e latência. O painel MediaPipe mostra EAR, face detectada e caixa. O CSV inclui timestamp, etapa, quadro, probabilidades/médias V2, probabilidade/decisão/estado/erro V3, EAR, detecção MediaPipe, caixas e latências.

Não são gravadas imagens nem vídeos.

## Validações executadas

- Python 3.12 confirmou TensorFlow 2.20.0, OpenCV 5.0.0 e NumPy 2.5.4.
- O modelo carregou com entrada `[None, 160, 160, 3]`, três saídas e SHA-256 `C87F4D6E362C399B15D1960CE841290C11F006C5CABCDE856CA088F18CAC00C6`.
- A V3 carregou com entrada `[None, 160, 160, 3]`, uma saída sigmoid e SHA-256 `BAB4CCEC941F6BF2C423A403D090E2E15396919AF3D1A3C89359B4DB52AB7F4F`.
- O cascade OpenCV foi carregado; o teste de paridade compara o recorte do painel com `preparar_rosto_olhos()` do runtime.
- Os 10 testes de `testes/simulador` passaram, incluindo paridade do recorte, serialização da resposta com caixa V3 e estados MediaPipe.
- O painel foi carregado e revisado visualmente no browser local; o teste do browser não acionou câmera nem WebSocket.

Predições em quadros sintéticos não são resultados de acurácia e não devem ser usadas para recomendar um modo. A execução visual requer câmera autorizada e acesso aos recursos CDN do MediaPipe.

## Limitação conhecida

Para a caixa V2 recortada, o navegador deriva a caixa dos landmarks FaceLandmarker (`caixa_origem=FaceLandmarker_landmarks`); ela pode diferir da caixa `mp.solutions.face_detection` de `camera_v2.py`. A V3, por outro lado, executa seu próprio Haar conforme o runtime e é independente da detecção MediaPipe. O CSV registra as caixas/origens separadamente para evitar falsa equivalência.

## Protocolo para recomendação

Executar quatro etapas manuais — OLHOS ABERTOS, OLHOS FECHADOS, FALANDO e BOCEJANDO — marcando a etapa antes de cada sequência e baixando o CSV ao final. Comparar, por etapa, a separação das probabilidades e a consistência entre quadros. Só integrar o modo recortado ao simulador principal se a vantagem aparecer de forma repetida nos quadros de OLHOS FECHADOS, sem degradar as outras etapas.
