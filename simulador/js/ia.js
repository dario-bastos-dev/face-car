// Scanner de rosto e estimador rodando na própria página (Parte 3, item 3).
//
//   webcam → MediaPipe Face Landmarker → extrator da Parte 1 (demo-navegador/extrator.js)
//          → histórico de métricas (contratos/metricas.v1.json)
//          → olhos, boca, cabeça, olhar e eventos (rosto.js, como entrada/rosto.py)
//          → a cada 100 ms: estimar → transicionar → emitir (Parte 2, módulos JS)
//          → mensagens sinal.v1 → sinal.js (mesmo caminho do WebSocket e do replay)
//
// O estado do motorista vem só do modelo de imagens treinado pelo time (cnn.js): o índice do
// modelo entra na política da Parte 2. Sem resultado recente do modelo, a evidência é inválida e
// o simulador fica em DEGRADADO (sem frear). A geometria (olhos, PERCLOS, boca, cabeça) segue
// sendo medida e mostrada, mas não comanda.
//
// Os ticks rodam a cada 100 ms mesmo sem quadros novos, como pede docs/parte2.md:
// sem rosto ou sem câmera, o estimador degrada e o simulador não freia.
// Nenhum quadro sai do navegador e nada é gravado; só as métricas podem ser exportadas.
import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs";
import { CalculadoraMetricas, pontosEmPixels, indiceDoMaiorRosto, matrizEmLinhas, cabecalhoCsv, linhaCsv } from "../../demo-navegador/extrator.js";
import { estimar, validarConfig } from "../../demo-navegador/estimador.js";
import { estadoInicial, transicionar } from "../../demo-navegador/politica.js";
import { estadoEmissorInicial, emitir } from "../../demo-navegador/mensagens.js";
import { MonitorRosto, direcaoDaCabeca, olharDaIris, olhos, rotuloDaCabeca, rotuloDoOlhar } from "./rosto.js";
import { MonitorHibrido } from "./monitor-hibrido.js";
import { conectarAvisoHibrido } from "./aviso-hibrido.js";

const V = window.VIGIA;
const $ = (id) => document.getElementById(id);
conectarAvisoHibrido(V, $("camWarning"));
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm";
const BUNDLE_CJS = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.cjs"; // para o worker
const LARGURA_MAX = 480;   // quadro mandado ao worker: o MediaPipe (256 px) reduz bem mais que isso
// Ritmo da detecção: 15 quadros/s (o estimador aceita até max_intervalo_ms = 250 ms entre quadros).
// O MediaPipe usa a mesma placa de vídeo que a 3D; a 22/s ele roubava tempo da animação.
const DETECCAO_MS = 66;
// Baixado por scripts/preparar.sh; sem ele, usa a mesma versão publicada pelo Google.
const MODELO_LOCAL = "../modelos/face_landmarker.task";
const MODELO_REMOTO = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const TICK_MS = 100;

const json = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); });
const [cfgExtrator, cfgEstimador, contrato, indices, cfgAnalise] = await Promise.all(
  ["../config/extrator.json", "../config/estimador.json", "../contratos/metricas.v1.json", "../entrada/pontos_rosto.json",
    "../config/analise.json"].map(json));
validarConfig(cfgEstimador);

// O MediaPipe roda num Web Worker (rosto-worker.js): na thread da página, cada quadro custava de
// 60 a 85 ms e travava a animação 2D e 3D. Se o worker não puder ser criado, roda aqui mesmo.
let landmarker = null, worker = null, carregando = null;
function opcoesMediapipe() {
  const mpc = cfgExtrator.mediapipe;
  return {
    runningMode: "VIDEO", numFaces: mpc.max_rostos ?? 1, // mapeia só o maior: o motorista
    minFaceDetectionConfidence: mpc.min_confianca_deteccao,
    minFacePresenceConfidence: mpc.min_confianca_presenca,
    minTrackingConfidence: mpc.min_confianca_rastreio,
    outputFacialTransformationMatrixes: true,
  };
}
function criarWorker(modelo) {
  return new Promise((ok, falha) => {
    const w = new Worker(new URL("./rosto-worker.js?v=0.9.126", import.meta.url));
    const fim = (erro) => { clearTimeout(limite); w.onmessage = w.onerror = null; if (erro) { w.terminate(); falha(erro); } else ok(w); };
    const limite = setTimeout(() => fim(new Error("o worker não respondeu")), 60000);
    w.onmessage = (e) => {
      if (e.data.tipo === "pronto") { V.log(`Scanner: MediaPipe em segundo plano (worker, ${e.data.delegate})`, "camera"); fim(); }
      else if (e.data.tipo === "erro") fim(new Error(e.data.erro));
    };
    w.onerror = (e) => { e.preventDefault?.(); fim(new Error(e.message || "falha ao criar o worker")); };
    w.postMessage({ tipo: "iniciar", bundle: BUNDLE_CJS, wasm: WASM, modelo, opcoes: opcoesMediapipe() });
  });
}
async function prepararLandmarker() {
  if (landmarker || worker) return;
  carregando ??= (async () => {
    const local = await fetch(MODELO_LOCAL, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
    const modelo = new URL(local ? MODELO_LOCAL : MODELO_REMOTO, location.href).href;
    try { worker = await criarWorker(modelo); }
    catch (e) {
      V.log("Scanner: worker indisponível, MediaPipe na página (" + e.message + ")", "error");
      const arquivos = await FilesetResolver.forVisionTasks(WASM);
      const opcoes = (delegate) => ({ ...opcoesMediapipe(), baseOptions: { modelAssetPath: modelo, delegate } });
      // GPU quando disponível; sem WebGL utilizável, cai para CPU (mesmo resultado, mais lento)
      try { landmarker = await FaceLandmarker.createFromOptions(arquivos, opcoes("GPU")); }
      catch { landmarker = await FaceLandmarker.createFromOptions(arquivos, opcoes("CPU")); }
    }
    V.log(`Scanner: modelo do MediaPipe carregado (${local ? "local" : "remoto"})`, "camera");
  })().catch((e) => { carregando = null; throw e; }); // permite tentar de novo
  return carregando;
}

// Estado da sessão do scanner
const S = { ativo: false, visivel: true, t0: 0, ultimoT: -1, quadro: 0, calc: null, historico: [], linhas: [],
  estado: null, emissor: null, respondeu: false, timer: null, sessao: "", ultimo: null, monitor: null,
  monitorHibrido: null, piscadas: 0 };
const RETENCAO = cfgEstimador.janela_s * 1000 + cfgEstimador.min_fechamento_ms + cfgEstimador.max_intervalo_ms;
const agora = () => Math.round(performance.now() - S.t0); // relógio monotônico da sessão (ms)

// Abertura dos olhos 0..1 pelas referências do estimador (média dos dois olhos).
function abertura(reg) {
  if (reg.ear_esq == null || reg.ear_dir == null) return null;
  const o = cfgEstimador.olhos;
  const a = (ear, lado) => Math.max(0, Math.min(1, (ear - o[`ear_fechado_${lado}`]) / (o[`ear_aberto_${lado}`] - o[`ear_fechado_${lado}`])));
  return (a(reg.ear_esq, "esq") + a(reg.ear_dir, "dir")) / 2;
}

// Marca de tempo da sessão para o quadro (estritamente crescente); null se não avançou.
function marcar(captura) {
  const t = Math.round(Math.min(captura, performance.now()) - S.t0);
  if (t <= S.ultimoT) return null;
  return (S.ultimoT = t);
}
// Sem worker: detecta aqui mesmo (bloqueia a página pelo tempo da detecção).
function aoQuadro(video, captura) {
  const t = marcar(captura);
  if (t == null) return;
  const res = landmarker.detectForVideo(video, t);
  analisar(res.faceLandmarks, res.facialTransformationMatrixes, video.videoWidth, video.videoHeight, t, captura);
}
// Com worker: copia o quadro (barato) e o transfere; o resultado chega em aoResultado.
let pendente = null; // quadro em análise no worker (um por vez: a página nunca acumula fila)
function mandarAoWorker(video, captura) {
  const t = marcar(captura);
  if (t == null) return;
  const vw = video.videoWidth, vh = video.videoHeight, escala = Math.min(1, LARGURA_MAX / vw);
  const q = (pendente = { sessao: S.sessao, t, captura, vw, vh });
  createImageBitmap(video, escala < 1 ? { resizeWidth: Math.round(vw * escala), resizeHeight: Math.round(vh * escala), resizeQuality: "medium" } : {})
    .then((bmp) => worker.postMessage({ tipo: "quadro", id: t, bmp }, [bmp]))
    .catch(() => { if (pendente === q) pendente = null; });
}
function aoResultado(e) {
  const d = e.data, q = pendente;
  if (!q || d.id !== q.t) return;
  pendente = null;
  if (!S.ativo || q.sessao !== S.sessao) return;
  if (d.tipo === "erro") { V.log("Scanner: erro no MediaPipe — " + d.erro, "error"); return; }
  analisar(d.faceLandmarks, d.matrizes, q.vw, q.vh, q.t, q.captura);
}
function analisar(faceLandmarks, matrizes, vw, vh, t, captura) {
  let pts = null, matriz = null, normalizados = null;
  // o MediaPipe devolve primeiro o rosto em que mais confia, que pode ser alguém ao fundo
  const rostos = faceLandmarks.map((r) => pontosEmPixels(r, vw, vh));
  const i = indiceDoMaiorRosto(rostos);
  if (i !== null) {
    pts = rostos[i];
    normalizados = faceLandmarks[i].map((p) => [p.x, p.y]);
    const m = matrizes?.[i];
    matriz = m ? matrizEmLinhas(m) : null;
  }
  const registro = S.calc.calcular(pts, matriz, t, S.quadro++, performance.now() - captura);
  S.historico.push(registro);
  while (S.historico.length && S.historico[0].t_ms < t - RETENCAO) S.historico.shift();
  if (S.linhas.length < 108000) S.linhas.push(linhaCsv(contrato, registro)); // até ~1 h a 30 fps
  // olhos, boca e cabeça pela geometria, com os limiares de config/analise.json
  const ear = registro.ear_esq != null && registro.ear_dir != null ? (registro.ear_esq + registro.ear_dir) / 2 : null;
  const rosto = S.monitor.registrar(t, pts ? ear : null, pts ? registro.abertura_boca : null, matriz ? rotuloDaCabeca(matriz) : null);
  const hibrido = S.monitorHibrido.registrar(t, Boolean(pts), ear);
  for (const evento of hibrido.eventos) V.log("Monitor híbrido: " + evento, "alert");
  V.emit("monitorHibrido", { t_ms: t, ...hibrido });
  for (const evento of rosto.eventos) {
    if (evento.startsWith("piscada")) S.piscadas++; // piscadas são normais: só contadas
    else V.log("Rosto: " + evento, "monitor");
  }
  S.ultimo = { ...S.ultimo, registro, pontos: normalizados, matriz, abertura: abertura(registro), rosto, hibrido,
    olhar: pts ? rotuloDoOlhar(pts, indices) : null, piscadas: S.piscadas,
    evento: rosto.eventos.length ? { texto: rosto.eventos.at(-1), t } : S.ultimo?.evento };
}

/* Olhos fechados (EAR do MediaPipe, monitor-hibrido.js): piscadas (até piscada_max_ms) não contam;
 * daí o índice sobe em linha reta até 100 em fechamento_saturacao_ms de olhos fechados sem parar.
 * Com 3 s de saturação: ~0,9 s fechado = 20 (atenção), ~1,4 s = 40 (crítico), ~2,2 s = 70.
 * Sem rosto ou sem leitura recente do EAR: null (não há evidência). */
function indiceOlhosFechados() {
  const h = S.ultimo?.hibrido, lim = cfgAnalise.rosto;
  if (h?.emEspera) return S.olhosIndice ?? null; // rosto sumiu por um instante: mantém o último valor
  if (!h?.valido || !V.ia?.rostoVisivel) return (S.olhosIndice = null);
  if (!h.olhosFechados) return (S.olhosIndice = 0);
  const ini = lim.piscada_max_ms ?? 400, sat = lim.fechamento_saturacao_ms ?? 3000;
  return (S.olhosIndice = Math.round(100 * Math.min(1, Math.max(0, (h.fechamentoContinuoMs - ini) / Math.max(1, sat - ini)))));
}
function tick() {
  if (!S.ativo) return;
  const t = agora();
  try {
    const geometria = estimar(S.historico.filter((r) => r.t_ms <= t), cfgEstimador, t); // só para exibir (PERCLOS)
    // Índice de fadiga 0..100 = o maior entre o do modelo CNN e o dos olhos fechados (EAR), mais o
    // bônus do volante frouxo (pressao.js), como a fusão da Parte 1 (entrada/pressao.py).
    // Faixas da política (config/estimador.json): <20 normal · 20-40 atenção (aviso inicial) ·
    // 40-70 crítico (aviso intermediário) · >=70 sem resposta: intervenção (aviso final).
    const modelo = V.cnn?.indice() ?? null, volante = V.pressao?.bonusIndice() ?? 0;
    const olhos = indiceOlhosFechados();
    const base = modelo == null && olhos == null ? null : Math.max(modelo ?? 0, olhos ?? 0);
    // mão frouxa: no mínimo ATENÇÃO (limiar 20), mas nunca crítico só por ela (40)
    let indice = base == null ? null : Math.min(100, volante ? Math.max(base + volante, 25) : base);
    // rosto perdido por um instante (até perda_rosto_tolerancia_ms): mantém o último índice em vez
    // de cair em DEGRADADO e perder o nível (uma intervenção em andamento, por exemplo)
    const tolerancia = cfgAnalise.rosto.perda_rosto_tolerancia_ms ?? 1000;
    if (indice != null) S.ultimoIndice = { v: indice, t };
    else if (S.ultimoIndice && t - S.ultimoIndice.t <= tolerancia) indice = S.ultimoIndice.v;
    const estimativa = { t_ms: t, indice, indice_modelo: modelo, indice_olhos: olhos, bonus_volante: volante, confianca: indice == null ? 0 : 1, perclos: geometria.perclos, indice_geometria: geometria.indice };
    S.fonte = modelo != null ? (olhos > modelo ? "olhos" : "cnn") : olhos != null ? "olhos" : "sem_cnn";
    S.estado = transicionar(S.estado, estimativa, t, cfgEstimador, S.respondeu);
    S.respondeu = false;
    let mensagens;
    [S.emissor, mensagens] = emitir(S.emissor, S.estado, estimativa, t, cfgEstimador);
    S.ultimo = { ...S.ultimo, estimativa, estado: mensagens.find((m) => m.tipo === "acao")?.estado ?? S.ultimo?.estado, fonte: S.fonte };
    for (const m of mensagens) V.sinal.receber(m, "ia");
    $("metricsCsvBtn").disabled = !S.linhas.length;
  } catch (e) {
    V.log("Scanner: erro no estimador — " + e.message, "error");
    parar();
  }
}

let rvfc = 0;
function laco() {
  const video = $("cameraFeed");
  let processado = -1e9;
  pendente = null;
  if (worker) worker.onmessage = aoResultado;
  const passo = (now, meta) => {
    if (!S.ativo) return;
    // até ~15 quadros/s (DETECCAO_MS); com o worker, só manda outro quadro quando o anterior voltou
    if (!(worker && pendente) && video.readyState >= 2 && video.videoWidth && now - processado >= DETECCAO_MS) {
      processado = now;
      if (worker) mandarAoWorker(video, meta?.captureTime ?? now); else aoQuadro(video, meta?.captureTime ?? now);
    }
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
    sessao: "pagina-" + Date.now().toString(36), respondeu: false, ultimo: null,
    monitor: new MonitorRosto(cfgAnalise.rosto), monitorHibrido: new MonitorHibrido(cfgAnalise.rosto), piscadas: 0, ultimoIndice: null, olhosIndice: null });
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
  get ultimo() { return S.ultimo; }, get sessao() { return S.sessao; }, indices, limiares: cfgAnalise.rosto,
  get rostoVisivel() { return !!S.ultimo?.registro?.rosto_visivel; }, // cnn.js só analisa com o motorista
  geo: { direcaoDaCabeca, olharDaIris, olhos }, // para o desenho em driver-monitor.js (script clássico)
  get monitoramentoHibrido() { return S.ultimo?.hibrido ?? null; },
  iniciar, parar, mostrar: () => alternarVisivel(true), ocultar: () => alternarVisivel(false),
  responder: () => { S.respondeu = true; },
  csv: () => [cabecalhoCsv(contrato), ...S.linhas].join("\n") + "\n",
};
atualizarBotoes();
