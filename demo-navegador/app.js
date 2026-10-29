// Liga a câmera ou um arquivo de vídeo ao MediaPipe e ao cálculo de extrator.js.
// A inferência roda no próprio navegador; nenhum quadro sai do dispositivo.
import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs";
import {
  CalculadoraMetricas, RelogioWebcam, pontosEmPixels, matrizEmLinhas, cabecalhoCsv, linhaCsv,
} from "./extrator.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm";
const $ = (id) => document.getElementById(id);
const video = $("video");
const tela = $("sobreposicao");
const ctx = tela.getContext("2d");

const [config, contrato, indices] = await Promise.all(
  ["../config/extrator.json", "../contratos/metricas.v1.json", "../entrada/pontos_rosto.json"]
    .map((u) => fetch(u).then((r) => r.json())));
const arquivos = await FilesetResolver.forVisionTasks(WASM);

let sessao = 0;        // incrementa a cada nova fonte, para encerrar a anterior
let linhas = [];
let landmarker = null;

async function novaSessao() {
  sessao++;
  linhas = [];
  $("baixar").disabled = true;
  landmarker?.close();
  const mpc = config.mediapipe;
  // Uma instância nova por fonte: o MediaPipe exige marcas de tempo crescentes,
  // e a estabilidade recomeça do zero.
  landmarker = await FaceLandmarker.createFromOptions(arquivos, {
    baseOptions: { modelAssetPath: "../" + mpc.modelo, delegate: "CPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: mpc.min_confianca_deteccao,
    minFacePresenceConfidence: mpc.min_confianca_presenca,
    minTrackingConfidence: mpc.min_confianca_rastreio,
    outputFacialTransformationMatrixes: true,
  });
  return { id: sessao, calc: new CalculadoraMetricas(config.confianca, indices) };
}

// O atraso é medido a partir de `inicio`: o instante de captura na webcam e,
// por padrão, o começo do processamento, como pede o contrato para arquivos.
function processar(s, tMs, quadro, inicio = performance.now()) {
  const res = landmarker.detectForVideo(video, tMs);
  const largura = video.videoWidth, altura = video.videoHeight;
  let pts = null, matriz = null;
  if (res.faceLandmarks.length) {
    pts = pontosEmPixels(res.faceLandmarks[0], largura, altura);
    const m = res.facialTransformationMatrixes?.[0];
    matriz = m ? matrizEmLinhas(m) : null;
  }
  const registro = s.calc.calcular(pts, matriz, tMs, quadro, performance.now() - inicio);
  linhas.push(linhaCsv(contrato, registro));
  desenhar(pts, registro, largura, altura);
  return registro;
}

function desenhar(pts, r, largura, altura) {
  tela.width = largura;
  tela.height = altura;
  ctx.clearRect(0, 0, largura, altura);
  if (pts) {
    ctx.fillStyle = "#3ddc84";
    const destaque = [...indices.olho_esquerdo, ...indices.olho_direito,
      ...indices.boca_pares_verticais.flat(), ...indices.boca_cantos];
    for (const i of destaque) ctx.fillRect(pts[i][0] - 2, pts[i][1] - 2, 4, 4);
  }
  const f = (v, n) => (v === null ? "—" : v.toFixed(n));
  $("valores").textContent = r.rosto_visivel
    ? `EAR esq ${f(r.ear_esq, 3)}  dir ${f(r.ear_dir, 3)}\n` +
      `boca ${f(r.abertura_boca, 3)}\n` +
      `yaw ${f(r.yaw, 1)}  pitch ${f(r.pitch, 1)}  roll ${f(r.roll, 1)}\n` +
      `confiança ${f(r.confianca, 2)}  atraso ${f(r.atraso_ms, 0)} ms`
    : `rosto não detectado\nconfiança ${f(r.confianca, 2)}`;
}

function concluir(mensagem) {
  $("estado").textContent = mensagem;
  $("baixar").disabled = linhas.length === 0;
  document.body.dataset.concluido = "1";
}

function csv() {
  return [cabecalhoCsv(contrato), ...linhas].join("\n") + "\n";
}

async function usarWebcam() {
  const s = await novaSessao();
  const cam = config.webcam;
  const fluxo = await navigator.mediaDevices.getUserMedia({
    video: { width: cam.largura, height: cam.altura }, audio: false });
  video.srcObject = fluxo;
  await video.play();
  const relogio = new RelogioWebcam();
  let quadro = 0;
  $("estado").textContent = "Webcam ativa.";
  const passo = (agora, metadados) => {
    if (s.id !== sessao) {
      fluxo.getTracks().forEach((t) => t.stop());
      return;
    }
    const marca = relogio.quadro(agora, metadados);
    if (marca) {
      processar(s, marca.tMs, quadro++, marca.captura);
      $("baixar").disabled = false;
    }
    video.requestVideoFrameCallback(passo);
  };
  video.requestVideoFrameCallback(passo);
}

// Processa um vídeo quadro a quadro, buscando o meio de cada quadro, com
// t_ms = round(i·1000/fps), como entrada/fontes.py faz no Python.
async function processarArquivo(url, fps) {
  const s = await novaSessao();
  video.srcObject = null;
  video.src = url;
  await new Promise((ok, erro) => {
    video.onloadeddata = ok;
    video.onerror = () => erro(new Error("Não foi possível abrir o vídeo"));
  });
  video.pause();
  const total = Math.floor(video.duration * fps + 1e-6);
  for (let i = 0; i < total && s.id === sessao; i++) {
    video.currentTime = (i + 0.5) / fps;
    await new Promise((ok) => video.addEventListener("seeked", ok, { once: true }));
    processar(s, Math.round((i * 1000) / fps), i);
    $("estado").textContent = `Quadro ${i + 1} de ${total}`;
  }
  if (s.id === sessao) concluir(`${linhas.length} quadros processados.`);
}

$("webcam").onclick = () => usarWebcam().catch((e) => ($("estado").textContent = e.message));
$("arquivo").onchange = (ev) => {
  const f = ev.target.files[0];
  if (f) processarArquivo(URL.createObjectURL(f), Number($("fps").value))
    .catch((e) => ($("estado").textContent = e.message));
};
$("parar").onclick = () => { sessao++; concluir(`Parado com ${linhas.length} quadros.`); };
$("baixar").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv()], { type: "text/csv" }));
  a.download = "metricas-navegador.csv";
  a.click();
};

// Automação: ?video=<url>&fps=<n> processa o vídeo e expõe o CSV em window.csvMetricas.
const params = new URLSearchParams(location.search);
window.csvMetricas = () => csv();
$("estado").textContent = "Pronto.";
if (params.get("video")) {
  const fps = Number(params.get("fps") || $("fps").value);
  $("fps").value = fps;
  processarArquivo(params.get("video"), fps).catch((e) => ($("estado").textContent = e.message));
}
