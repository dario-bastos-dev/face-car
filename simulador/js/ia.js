// Scanner de rosto e estimador rodando na própria página (Parte 3, item 3).
//
//   webcam → MediaPipe Face Landmarker → extrator da Parte 1 (demo-navegador/extrator.js)
//          → histórico de métricas (contratos/metricas.v1.json)
//          → a cada 100 ms: estimar → transicionar → emitir (Parte 2, módulos JS)
//          → mensagens sinal.v1 → sinal.js (mesmo caminho do WebSocket e do replay)
//
// Os ticks rodam a cada 100 ms mesmo sem quadros novos, como pede docs/parte2.md:
// sem rosto ou sem câmera, o estimador degrada e o simulador não freia.
// Nenhum quadro sai do navegador e nada é gravado; só as métricas podem ser exportadas.
import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs";
import { CalculadoraMetricas, pontosEmPixels, matrizEmLinhas, cabecalhoCsv, linhaCsv } from "../../demo-navegador/extrator.js";
import { estimar, validarConfig } from "../../demo-navegador/estimador.js";
import { estadoInicial, transicionar } from "../../demo-navegador/politica.js";
import { estadoEmissorInicial, emitir } from "../../demo-navegador/mensagens.js";
import { carregarModelo, preverModelo } from "./modelo.js";

const V = window.VIGIA;
const $ = (id) => document.getElementById(id);
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm";
// Baixado por scripts/preparar.sh; sem ele, usa a mesma versão publicada pelo Google.
const MODELO_LOCAL = "../modelos/face_landmarker.task";
const MODELO_REMOTO = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const TICK_MS = 100;

const json = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); });
const [cfgExtrator, cfgEstimador, contrato, indices] = await Promise.all(
  ["../config/extrator.json", "../config/estimador.json", "../contratos/metricas.v1.json", "../entrada/pontos_rosto.json"].map(json));
validarConfig(cfgEstimador);
const modeloParte4 = await carregarModelo("../modelos/modelo_sonolencia.json");

let landmarker = null, carregando = null;
async function prepararLandmarker() {
  if (landmarker) return landmarker;
  carregando ??= (async () => {
    const arquivos = await FilesetResolver.forVisionTasks(WASM);
    const local = await fetch(MODELO_LOCAL, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
    const mpc = cfgExtrator.mediapipe;
    const opcoes = (delegate) => ({
      baseOptions: { modelAssetPath: local ? MODELO_LOCAL : MODELO_REMOTO, delegate },
      runningMode: "VIDEO", numFaces: 1,
      minFaceDetectionConfidence: mpc.min_confianca_deteccao,
      minFacePresenceConfidence: mpc.min_confianca_presenca,
      minTrackingConfidence: mpc.min_confianca_rastreio,
      outputFacialTransformationMatrixes: true,
    });
    // GPU quando disponível; sem WebGL utilizável, cai para CPU (mesmo resultado, mais lento)
    try { landmarker = await FaceLandmarker.createFromOptions(arquivos, opcoes("GPU")); }
    catch { landmarker = await FaceLandmarker.createFromOptions(arquivos, opcoes("CPU")); }
    V.log(`Scanner: modelo do MediaPipe carregado (${local ? "local" : "remoto"})`, "camera");
    return landmarker;
  })().catch((e) => { carregando = null; throw e; }); // permite tentar de novo
  return carregando;
}

// Estado da sessão do scanner
const S = { ativo: false, visivel: true, t0: 0, ultimoT: -1, quadro: 0, calc: null, historico: [], linhas: [],
  estado: null, emissor: null, respondeu: false, timer: null, sessao: "", ultimo: null };
const RETENCAO = cfgEstimador.janela_s * 1000 + cfgEstimador.min_fechamento_ms + cfgEstimador.max_intervalo_ms;
const agora = () => Math.round(performance.now() - S.t0); // relógio monotônico da sessão (ms)

// Abertura dos olhos 0..1 pelas referências do estimador (média dos dois olhos).
function abertura(reg) {
  if (reg.ear_esq == null || reg.ear_dir == null) return null;
  const o = cfgEstimador.olhos;
  const a = (ear, lado) => Math.max(0, Math.min(1, (ear - o[`ear_fechado_${lado}`]) / (o[`ear_aberto_${lado}`] - o[`ear_fechado_${lado}`])));
  return (a(reg.ear_esq, "esq") + a(reg.ear_dir, "dir")) / 2;
}

function aoQuadro(video, captura) {
  const t = Math.round(Math.min(captura, performance.now()) - S.t0);
  if (t <= S.ultimoT) return; // o MediaPipe exige marcas estritamente crescentes
  S.ultimoT = t;
  const res = landmarker.detectForVideo(video, t);
  let pts = null, matriz = null, normalizados = null;
  if (res.faceLandmarks.length) {
    normalizados = res.faceLandmarks[0].map((p) => [p.x, p.y]);
    pts = pontosEmPixels(res.faceLandmarks[0], video.videoWidth, video.videoHeight);
    const m = res.facialTransformationMatrixes?.[0];
    matriz = m ? matrizEmLinhas(m) : null;
  }
  const registro = S.calc.calcular(pts, matriz, t, S.quadro++, performance.now() - captura);
  S.historico.push(registro);
  while (S.historico.length && S.historico[0].t_ms < t - RETENCAO) S.historico.shift();
  if (S.linhas.length < 108000) S.linhas.push(linhaCsv(contrato, registro)); // até ~1 h a 30 fps
  S.ultimo = { ...S.ultimo, registro, pontos: normalizados, abertura: abertura(registro) };
}

function tick() {
  if (!S.ativo) return;
  const t = agora();
  try {
    const estimativa = estimar(S.historico.filter((r) => r.t_ms <= t), cfgEstimador, t);
    S.estado = transicionar(S.estado, estimativa, t, cfgEstimador, S.respondeu);
    S.respondeu = false;
    let mensagens;
    [S.emissor, mensagens] = emitir(S.emissor, S.estado, estimativa, t, cfgEstimador);
    const prob = preverModelo(modeloParte4, S.historico, estimativa);
    S.ultimo = { ...S.ultimo, estimativa, estado: mensagens.find((m) => m.tipo === "acao")?.estado ?? S.ultimo?.estado, prob };
    for (const m of mensagens) V.sinal.receber(m, "ia");
    atualizarPainel();
  } catch (e) {
    V.log("Scanner: erro no estimador — " + e.message, "error");
    parar();
  }
}

let rvfc = 0;
function laco() {
  const video = $("cameraFeed");
  const passo = (now, meta) => {
    if (!S.ativo) return;
    if (video.readyState >= 2 && video.videoWidth) aoQuadro(video, meta?.captureTime ?? now);
    rvfc = video.requestVideoFrameCallback(passo);
  };
  rvfc = video.requestVideoFrameCallback(passo);
}

async function iniciar(visivel = true) {
  S.visivel = visivel;
  if (S.ativo) { atualizarBotoes(); V.sinal.abrirCanal("ia", S.sessao); return; }
  if (!V.monitor.cameraActive) { await V.monitor.startCamera(); if (!V.monitor.cameraActive) return; }
  S.carregando = true; atualizarBotoes();
  try { await prepararLandmarker(); }
  catch (e) { S.carregando = false; atualizarBotoes(); V.log("Scanner: não foi possível carregar o MediaPipe — " + e.message, "error"); return; }
  S.carregando = false;
  Object.assign(S, { ativo: true, t0: performance.now(), ultimoT: -1, quadro: 0, historico: [], linhas: [],
    calc: new CalculadoraMetricas(cfgExtrator.confianca, indices), estado: estadoInicial(),
    sessao: "pagina-" + Date.now().toString(36), respondeu: false, ultimo: null });
  S.emissor = estadoEmissorInicial(S.sessao);
  V.sinal.abrirCanal("ia", S.sessao);
  laco();
  S.timer = setInterval(tick, TICK_MS);
  V.log(`Scanner ativo (${visivel ? "demonstração" : "invisível"}) · sessão ${S.sessao}`, "camera");
  atualizarBotoes();
}
function parar() {
  if (!S.ativo) return;
  S.ativo = false;
  clearInterval(S.timer);
  $("cameraFeed").cancelVideoFrameCallback?.(rvfc);
  if (V.sinal.canal === "ia") V.sinal.fecharCanal("Scanner desligado: canal de sinal fechado", true);
  V.log("Scanner desligado", "camera");
  atualizarBotoes();
}
function alternarVisivel(visivel) {
  if (!S.ativo) return iniciar(visivel);
  S.visivel = visivel;
  if (V.sinal.canal !== "ia") V.sinal.abrirCanal("ia", S.sessao); // retoma o comando se estava em manual
  V.log(visivel ? "Scanner em modo demonstração (malha visível)" : "Scanner invisível (continua rodando)", "camera");
  atualizarBotoes();
}

/* ---------- interface ---------- */
function atualizarBotoes() {
  const estado = S.carregando ? "carregando" : !S.ativo ? "desligado" : S.visivel ? "visivel" : "invisivel";
  document.querySelectorAll("[data-scanner]").forEach((b) => {
    const modo = b.dataset.scanner;
    b.classList.toggle("on", (modo === "demonstrar" && estado === "visivel") || (modo === "invisivel" && estado === "invisivel"));
    b.disabled = S.carregando;
  });
  document.querySelectorAll("[data-scanner-status]").forEach((el) => {
    el.textContent = { carregando: "CARREGANDO…", desligado: "SCANNER DESLIGADO", visivel: "SCANNER ATIVO", invisivel: "SCANNER INVISÍVEL" }[estado];
    el.dataset.estado = estado;
  });
  $("metricsCsvBtn").disabled = !S.linhas.length;
}
function atualizarPainel() {
  const p = S.ultimo?.prob;
  const txt = !modeloParte4 ? "Modelo (Parte 4): ainda não treinado"
    : p == null ? "Modelo (Parte 4): carregado · aguardando dados" : `Modelo (Parte 4): ${Math.round(p * 100)}% de sonolência`;
  document.querySelectorAll("[data-modelo]").forEach((el) => { if (el.textContent !== txt) el.textContent = txt; });
  $("metricsCsvBtn").disabled = !S.linhas.length;
}
function baixarCsv() {
  const csv = [cabecalhoCsv(contrato), ...S.linhas].join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `metricas-${S.sessao || "scanner"}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  V.log(`Métricas exportadas (${S.linhas.length} quadros, contrato metricas.v1)`, "export");
}

document.querySelectorAll("[data-scanner]").forEach((b) => {
  b.onclick = () => alternarVisivel(b.dataset.scanner === "demonstrar");
});
$("metricsCsvBtn").onclick = baixarCsv;
V.on("cameraOff", parar);

V.ia = {
  get ativo() { return S.ativo; }, get visivel() { return S.visivel; }, get carregando() { return !!S.carregando; },
  get ultimo() { return S.ultimo; }, get sessao() { return S.sessao; }, get modelo() { return modeloParte4; }, indices,
  iniciar, parar, mostrar: () => alternarVisivel(true), ocultar: () => alternarVisivel(false),
  responder: () => { S.respondeu = true; },
  csv: () => [cabecalhoCsv(contrato), ...S.linhas].join("\n") + "\n",
};
atualizarBotoes();
atualizarPainel();
