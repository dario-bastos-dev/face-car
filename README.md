# Captura do rosto do motorista

Lê as webcams (a colorida e a infravermelha) ou um vídeo, encontra o rosto com o MediaPipe Face
Landmarker e grava, a cada intervalo fixo, três recortes: o **rosto** (224×224 px), os **olhos** e a
**boca** (96×96 px). Os recortes de olhos e boca seguem exatamente o recorte usado no treino das
CNNs de olhos e boca (`treinamento/preparar_regioes.py`), para o modelo receber o mesmo tipo de
imagem que viu no treino.

## Preparar

```bash
uv sync                      # Python 3.12, mediapipe, opencv-contrib-python, numpy, pytest
./scripts/preparar.sh        # baixa o modelo e gera o vídeo de teste (precisa de ffmpeg)
```

## Capturar

```bash
uv run python -m entrada webcam --rotulo alerta --pessoa p01 --mostrar               # as duas câmeras
uv run python -m entrada webcam --camera rgb --rotulo alerta --pessoa p01            # só a colorida
uv run python -m entrada video <seu-video.mp4> --rotulo sonolento --pessoa p07       # vídeo gravado
```

| Opção | Padrão | Efeito |
| --- | --- | --- |
| `--rotulo` | `sem_rotulo` | classe das imagens; vira a pasta |
| `--pessoa` | `anonimo` | identificador da pessoa; vai no nome do arquivo |
| `--camera` | todas (webcam), `rgb` (vídeo) | webcam: quais câmeras da configuração usar (repetível); vídeo: nome da pasta |
| `--intervalo-ms` | 1000 | tempo mínimo entre duas capturas |
| `--saida` | `saidas/imagens` | pasta raiz dos recortes |
| `--segundos` | sem limite | webcam: parar depois deste tempo |
| `--mostrar` | desligado | uma janela por câmera com o quadrado do rosto; pisca em verde a cada captura |

Os arquivos ficam em `<saida>/<camera>/<regiao>/<rotulo>/<pessoa>_<origem>_<t_ms>ms.jpg`, com
`regiao` = `rosto`, `olhos` ou `boca`. Uma pasta por classe é o formato que as bibliotecas de treino
de imagens leem direto, e a pessoa no nome permite separar treino e teste por pessoa, para o
modelo não decorar rostos. As câmeras usam o mesmo relógio, então o `t_ms` de uma captura na
`rgb` e na `ir` se comparam.

## Câmeras

As câmeras ficam em `config/captura.json` pelo caminho fixo em `/dev/v4l/by-path/`, e não pelo
número (`/dev/video0`, `/dev/video2`), que pode mudar ao reiniciar ou reconectar. Em outro
computador, veja os caminhos com `ls -l /dev/v4l/by-path/` e `v4l2-ctl --list-devices`.

| Nome | Câmera | Imagem |
| --- | --- | --- |
| `rgb` | HD Webcam | colorida, 640×480 |
| `ir` | IR Camera | infravermelha em tons de cinza, 640×360 |

## Como os recortes são feitos

- O MediaPipe procura até 3 rostos e só o **maior** é recortado: o do motorista, mais perto da
  câmera. Pessoas ao fundo não entram no conjunto de dados.
- **Rosto:** quadrado centrado, com lado 1,5 vez o maior eixo do rosto (`recorte.rosto.margem =
  0.25`). Perto da borda, a parte fora da imagem é preenchida de preto.
- **Olhos e boca:** caixa em volta dos pontos da região (os dois olhos juntos num só recorte), com
  margem de 35% na horizontal e 45% na vertical (mínimo 8 px), cortada nas bordas e redimensionada
  para 96×96. As constantes estão em `entrada/recorte.py` e precisam continuar iguais às do treino.
- Quadros sem rosto não geram imagem e não consomem a vez: a captura acontece no primeiro quadro
  com rosto depois que o intervalo passou.

## Privacidade

Os recortes são dados pessoais (LGPD). Eles ficam só neste computador: `saidas/` está no
`.gitignore` e nunca vai para o repositório. Grave apenas pessoas que concordaram, e não induza
sono ou embriaguez reais para gerar dados.

## Testes

```bash
uv run pytest                # os testes com MediaPipe precisam de ./scripts/preparar.sh antes
```

## Estrutura

```
config/          parâmetros da captura e das câmeras
entrada/         fontes de vídeo, detector, recortes, agendamento e gravação, linha de comando
scripts/         preparação do modelo e do vídeo de teste
testes/          testes (entrada/) e dados gerados pelo preparar.sh (dados/)
```
