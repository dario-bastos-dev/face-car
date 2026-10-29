#!/usr/bin/env bash
# Baixa o modelo do Face Landmarker e gera o vídeo sintético usado nos testes.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p modelos testes/dados
[ -f modelos/face_landmarker.task ] || curl -sSfL -o modelos/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
[ -f testes/dados/retrato.jpg ] || curl -sSfL -o testes/dados/retrato.jpg \
  https://storage.googleapis.com/mediapipe-assets/portrait.jpg

# 4 s a 30 fps: parado (0-1 s), tela preta sem rosto (1-1,5 s), parado (1,5-2 s)
# e rolagem oscilando até cerca de ±20° (2-4 s). O rotate do ffmpeg gira no
# sentido horário para ângulos positivos.
ffmpeg -loglevel error -y -loop 1 -framerate 30 -i testes/dados/retrato.jpg -t 4 \
  -vf "scale=410:512,rotate='if(lt(t,2),0,0.35*sin(2*PI*(t-2)/2))':fillcolor=gray,drawbox=enable='between(t,1,1.5)':color=black:t=fill,format=yuv420p" \
  -c:v libx264 -r 30 testes/dados/retrato.mp4
# O mesmo vídeo a 25 fps, para conferir que Python e navegador usam o fps do arquivo.
ffmpeg -loglevel error -y -i testes/dados/retrato.mp4 -r 25 -c:v libx264 -pix_fmt yuv420p \
  testes/dados/retrato25.mp4
echo "Pronto: modelos/face_landmarker.task, testes/dados/retrato.mp4 e retrato25.mp4"
