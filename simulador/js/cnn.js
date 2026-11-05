// Modelo de imagens da Parte 1 (cnn_sonolencia.keras) rodando no servidor Python.
//
//   câmera da página → quadro inteiro reduzido ao tamanho de entrada do modelo (RGB, sem desenho)
//   → WebSocket /cnn do simulador/servidor.py → sonolento / alerta / bocejo + média da janela
//
// A média (config/analise.json, classificador.janela_ms) vira o índice que comanda os níveis
// do simulador no lugar do índice geométrico, pela mesma política da Parte 2 (ia.js). Um quadro
// por vez fica em trânsito; os quadros não são gravados nem saem do computador.
//
// Calibração por motorista: o modelo atual dá "sonolento" alto até para rostos acordados (num
// retrato sorrindo, 75% no quadro inteiro). Nos primeiros segundos com o rosto à frente, mede-se
// a resposta do modelo para esta pessoa acordada (a linha de base) e daí em diante só conta o que
// passar dela com folga: p' = (p - base - folga) / (1 - base - folga). Enquanto calibra, os níveis
// vêm da geometria. Se a base de sonolência já for alta (o modelo vê sono num rosto acordado), o
// modelo não separa nada para esta pessoa: o painel avisa e os níveis seguem pela geometria.
const V = window.VIGIA;
const $ = (id) => document.getElementById(id);
const INTERVALO_MS = 66;      // até ~15 quadros por segundo
const VALIDADE_MS = 800;      // resultado mais velho que isto não comanda os níveis
const PESO_BOCEJO = 0.45;     // bocejo sozinho leva a ATENÇÃO (limiar 35), não a ALERTA
const CALIBRACAO_MS = 5000;   // tempo de rosto à frente para medir a linha de base
const BASE_CONFIAVEL = 0.6;   // base de sonolência acima disto: modelo não confiável para este rosto
const FOLGA = 0.1;            // margem acima da base para o ruído de quadro a quadro

const C = { estado: "desligado", motivo: "", url: null, tamanho: 0, classes: [], ultimo: null, recebidoEm: 0 };
// calibração: amostras por classe enquanto calibra; base = média por classe ao terminar
const cal = { sessao: null, inicio: 0, soma: {}, n: 0, base: null };
let ws = null, canvas = null, ctx = null, emTransito = false, enviadoEm = 0, tentativaEm = -1e9;

async function descobrirUrl() {
  const pedida = new URLSearchParams(location.search).get("cnn");
  if (pedida) return pedida;
  try {
    const r = await fetch("servidor.json", { cache: "no-store" });
    if (r.ok) return `ws://${location.hostname}:${(await r.json()).ws}/cnn`;
  } catch { /* servidor estático sem o modelo */ }
  return null;
}

function definir(estado, motivo = "") {
  C.estado = estado; C.motivo = motivo;
  painel(true);
}

async function conectar() {
  if (ws) return;
  tentativaEm = performance.now();
  C.url ??= await descobrirUrl();
  if (!C.url) { definir("sem_servidor"); return; }
  definir("conectando");
  const w = ws = new WebSocket(C.url);
  w.binaryType = "arraybuffer";
  w.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.tipo === "cnn") {
      emTransito = false;
      C.ultimo = m; C.recebidoEm = performance.now();
      calibrar(m);
      painel();
    } else if (m.tipo === "cnn_pronto") {
      C.tamanho = m.tamanho; C.classes = m.classes;
      canvas = Object.assign(document.createElement("canvas"), { width: m.tamanho, height: m.tamanho });
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      definir("pronto");
      V.log(`Modelo CNN conectado (${m.classes.join(", ")}; entrada ${m.tamanho}×${m.tamanho})`, "camera");
    } else if (m.tipo === "cnn_indisponivel") {
      definir("indisponivel", m.motivo || "");
      V.log("Modelo CNN indisponível no servidor: " + (m.motivo || "motivo não informado"), "error");
    }
  };
  w.onclose = () => {
    if (ws !== w) return;
    ws = null; emTransito = false;
    if (C.estado === "pronto" || C.estado === "conectando") definir("desconectado");
  };
}

// Quadro inteiro da câmera (sem o espelhamento da tela) em tamanho x tamanho, RGB.
function enviarQuadro() {
  const agora = performance.now();
  if (!V.ia?.ativo) return;
  // reconecta sozinho; com o modelo indisponível, tenta de novo com menos frequência
  if (!ws) { if (agora - tentativaEm > (C.estado === "indisponivel" ? 15000 : 5000)) conectar(); return; }
  if (ws.readyState !== WebSocket.OPEN || C.estado !== "pronto") return;
  if (emTransito && agora - enviadoEm < 2000) return; // resposta perdida: segue depois de 2 s
  if (agora - enviadoEm < INTERVALO_MS) return;
  const video = $("cameraFeed");
  if (video.readyState < 2 || !video.videoWidth) return;
  const S = C.tamanho;
  ctx.drawImage(video, 0, 0, S, S);
  const rgba = ctx.getImageData(0, 0, S, S).data, buf = new ArrayBuffer(8 + S * S * 3);
  new DataView(buf).setFloat64(0, agora, true);
  const rgb = new Uint8Array(buf, 8);
  for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
  ws.send(buf);
  emTransito = true; enviadoEm = agora;
}

function fresco() { return !!C.ultimo && performance.now() - C.recebidoEm < VALIDADE_MS; }

/* ---------- calibração por motorista ---------- */
function recalibrar() {
  Object.assign(cal, { sessao: V.ia?.sessao ?? null, inicio: 0, soma: {}, n: 0, base: null });
  painel(true);
}
function calibrar(m) {
  if (!V.ia?.ativo) return;
  if (cal.sessao !== V.ia.sessao) recalibrar(); // scanner religado: outra pessoa, outra luz
  if (cal.base) return;
  if (!V.ia.ultimo?.registro?.rosto_visivel) return; // sem rosto, a amostra não conta (pausa, não zera)
  cal.inicio ||= performance.now();
  for (const [k, v] of Object.entries(m.probabilidades)) cal.soma[k] = (cal.soma[k] ?? 0) + v;
  cal.n++;
  if (performance.now() - cal.inicio >= CALIBRACAO_MS && cal.n >= 10) {
    cal.base = Object.fromEntries(Object.entries(cal.soma).map(([k, v]) => [k, v / cal.n]));
    const base = Object.entries(cal.base).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ');
    if (confiavel()) V.log(`Modelo CNN calibrado para este motorista (base: ${base})`, "camera");
    else V.log(`Modelo CNN não confiável para este rosto (acordado, já marca ${base}); os níveis seguem pela geometria dos olhos`, "error");
  }
}
const confiavel = () => !!cal.base && (cal.base.sonolento ?? 0) <= BASE_CONFIAVEL;
// Probabilidades da janela já descontada a linha de base (sonolento e bocejo); alerta é o resto.
function media() {
  if (!fresco() || !confiavel()) return null;
  const p = C.ultimo.media.probabilidades;
  const ajuste = (k) => { const b = Math.min(.9, (cal.base[k] ?? 0) + FOLGA); return Math.max(0, Math.min(1, ((p[k] ?? 0) - b) / (1 - b))); };
  const sonolento = ajuste("sonolento"), bocejo = ajuste("bocejo");
  const probabilidades = { sonolento, alerta: Math.max(0, 1 - sonolento - bocejo), bocejo };
  const classe = Object.entries(probabilidades).sort((a, b) => b[1] - a[1])[0][0];
  return { classe, probabilidades };
}
// Índice 0..100 a partir da média calibrada: sonolência pesa inteira e bocejo, parcialmente.
function indice() {
  const m = media();
  if (!m) return null;
  const p = m.probabilidades;
  return Math.round(100 * Math.min(1, p.sonolento + PESO_BOCEJO * p.bocejo));
}

/* ---------- painel no cartão da câmera ---------- */
const ROTULO = { sonolento: "Sonolento", alerta: "Alerta", bocejo: "Bocejo" };
let pintadoEm = 0;
function painel(forcar = false) {
  const el = document.querySelector("[data-cnn]");
  if (!el || (!forcar && performance.now() - pintadoEm < 200)) return;
  pintadoEm = performance.now();
  const status = el.querySelector("[data-cnn-status]"), barras = el.querySelector("[data-cnn-barras]");
  const restante = cal.inicio ? Math.max(0, Math.ceil((CALIBRACAO_MS - (performance.now() - cal.inicio)) / 1000)) : null;
  const situacao = !fresco() ? "aguardando quadros"
    : !cal.base ? (restante == null ? "calibrando · olhe para a frente" : `calibrando · olhe para a frente (${restante} s)`)
    : !confiavel() ? `não confiável p/ este rosto (base ${Math.round(cal.base.sonolento * 100)}% sono) · níveis pela geometria`
    : "comanda os níveis";
  const texto = {
    desligado: "liga com o scanner", sem_servidor: "abra pelo simulador/servidor.py",
    conectando: "conectando…", desconectado: "servidor desconectado · tentando de novo",
    indisponivel: "modelo indisponível no servidor", pronto: C.ultimo ? `${C.ultimo.qps} q/s · ${situacao}` : "pronto · aguardando quadros",
  }[C.estado];
  status.textContent = texto; status.title = C.motivo;
  el.dataset.estado = C.estado;
  const md = media(), p = md?.probabilidades ?? null, top = md?.classe ?? null;
  el.querySelector("[data-cnn-recalibrar]").hidden = !cal.base;
  const classes = C.classes.length ? C.classes : ["sonolento", "alerta", "bocejo"];
  if (barras.children.length !== classes.length) {
    barras.replaceChildren(...classes.map((c) => {
      const d = document.createElement("div");
      d.className = "cnn-classe"; d.dataset.classe = c;
      d.innerHTML = `<small>${ROTULO[c] || c}</small><span class="bar"><i></i></span><b>—</b>`;
      return d;
    }));
  }
  for (const d of barras.children) {
    const v = p ? p[d.dataset.classe] ?? 0 : null;
    d.querySelector("i").style.width = (v == null ? 0 : Math.max(2, v * 100)) + "%";
    d.querySelector("b").textContent = v == null ? "—" : Math.round(v * 100) + "%";
    d.classList.toggle("top", d.dataset.classe === top);
  }
}

V.addRenderer(() => { enviarQuadro(); painel(); });
document.querySelector("[data-cnn-recalibrar]").onclick = () => { recalibrar(); V.log("Modelo CNN: recalibrando (olhe para a frente)", "camera"); };
V.cnn = {
  get estado() { return C.estado; }, get ultimo() { return C.ultimo; }, get base() { return cal.base; }, get confiavel() { return confiavel(); },
  fresco, media, indice, conectar, recalibrar,
};
conectar();
