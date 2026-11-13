// Modelo de imagens da Parte 1 (cnn_sonolencia.keras) rodando no servidor Python.
//
//   câmera da página → quadro inteiro reduzido ao tamanho de entrada do modelo (RGB, sem desenho)
//   → WebSocket /cnn do simulador/servidor.py → sonolento / alerta / bocejo + média da janela
//
// A leitura do motorista vem só do modelo treinado pelo time (Parte 4), com os parâmetros de
// config/analise.json: as classes, na ordem do modelo, e a janela da média (classificador.janela_ms),
// como na análise em tempo real em Python (entrada/__main__.py). A média vira o índice que entra na
// política da Parte 2 (ia.js); sem resultado recente do modelo, o simulador fica em DEGRADADO.
// Cada leitura fica guardada para validação e pode ser exportada em CSV.
//
// O quadro do modelo é capturado aqui, a até 8 por segundo, sem depender do MediaPipe: antes ele
// ia junto com o quadro do worker e ficava limitado à velocidade do rastreio (3 q/s num notebook).
// Como na análise em Python, sem o motorista na câmera nenhum quadro vai ao modelo e o índice some.
const V = window.VIGIA;
const $ = (id) => document.getElementById(id);
const INTERVALO_MS = 125;     // até ~8 quadros por segundo: a média de 2 s não precisa de mais, e a animação fica livre
const VALIDADE_MS = 800;      // resultado mais velho que isto não comanda os níveis
const PESO_BOCEJO = 0.45;     // bocejo sozinho leva a ATENÇÃO (limiar 35), não a ALERTA
const MAX_LEITURAS = 36000;    // ~1 h de leituras guardadas para a validação

const C = { estado: "desligado", motivo: "", url: null, tamanho: 0, classes: [], ultimo: null, recebidoEm: 0 };
const leituras = [];          // uma linha por resultado do modelo (exportável em CSV)
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
      registrar(m);
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

// Pode mandar outro quadro agora? (Também reconecta sozinho; com o modelo indisponível, tenta de
// novo com menos frequência.)
function podeEnviar(agora) {
  if (!V.ia?.ativo || !V.ia.rostoVisivel) return false;   // sem o motorista na câmera, sem análise
  if (!ws) { if (agora - tentativaEm > (C.estado === "indisponivel" ? 15000 : 5000)) conectar(); return false; }
  if (ws.readyState !== WebSocket.OPEN || C.estado !== "pronto") return false;
  if (emTransito && agora - enviadoEm < 2000) return false; // resposta perdida: segue depois de 2 s
  return agora - enviadoEm >= INTERVALO_MS;
}
// Quadro inteiro da câmera (sem o espelhamento da tela) em tamanho x tamanho, RGB: reduzir a
// 160x160 e copiar os pixels custa 3 a 4 ms na página, bem menos que o MediaPipe.
function enviarQuadro() {
  const agora = performance.now();
  if (!podeEnviar(agora)) return;
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

// Resultado recente e com o motorista na câmera: só então o modelo comanda.
function fresco() {
  return !!C.ultimo && performance.now() - C.recebidoEm < VALIDADE_MS && !!V.ia?.rostoVisivel;
}

// Média da janela, como o modelo devolveu (classe com a maior probabilidade média).
function media() { return fresco() ? C.ultimo.media : null; }
// Índice 0..100: sonolência pesa inteira e bocejo, parcialmente.
function indice() {
  const m = media();
  if (!m) return null;
  const p = m.probabilidades;
  return Math.round(100 * Math.min(1, (p.sonolento ?? 0) + PESO_BOCEJO * (p.bocejo ?? 0)));
}

/* ---------- leituras para validação ---------- */
function registrar(m) {
  if (leituras.length >= MAX_LEITURAS) return;
  const pm = m.media.probabilidades, ix = Math.round(100 * Math.min(1, (pm.sonolento ?? 0) + PESO_BOCEJO * (pm.bocejo ?? 0)));
  leituras.push([Math.round(m.t_ms), m.classe, ...C.classes.map(k => m.probabilidades[k]?.toFixed(4)), m.media.classe,
    ...C.classes.map(k => pm[k]?.toFixed(4)), ix, V.ia?.ultimo?.estado ?? "", V.state.level, m.ms]);
  const b = document.getElementById("cnnCsvBtn"); if (b) b.disabled = false;
}
function baixarCsv() {
  const cab = ["t_ms", "classe", ...C.classes.map(k => "p_" + k), "classe_media", ...C.classes.map(k => "media_" + k), "indice", "estado_sinal", "nivel_simulador", "ms_previsao"];
  const csv = [cab.join(","), ...leituras.map(l => l.join(","))].join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `leituras-cnn-${V.ia?.sessao || "sessao"}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  V.log(`Leituras do modelo CNN exportadas (${leituras.length})`, "export");
}

/* ---------- painel no cartão da câmera ---------- */
const ROTULO = { sonolento: "Sonolento", alerta: "Alerta", bocejo: "Bocejo" };
let pintadoEm = 0;
function painel(forcar = false) {
  const el = document.querySelector("[data-cnn]");
  if (!el || (!forcar && performance.now() - pintadoEm < 200)) return;
  pintadoEm = performance.now();
  const status = el.querySelector("[data-cnn-status]"), barras = el.querySelector("[data-cnn-barras]");
  const situacao = V.ia?.ativo && !V.ia.rostoVisivel ? "motorista não visível · sem análise"
    : !fresco() ? "aguardando quadros" : "comanda os níveis";
  const texto = {
    desligado: "liga com o scanner", sem_servidor: "abra pelo simulador/servidor.py",
    conectando: "conectando…", desconectado: "servidor desconectado · tentando de novo",
    indisponivel: "modelo indisponível no servidor",
    pronto: C.ultimo && fresco() ? `${C.ultimo.qps} q/s · ${situacao}` : `pronto · ${situacao}`,
  }[C.estado];
  status.textContent = texto; status.title = C.motivo;
  el.dataset.estado = C.estado;
  const md = media(), p = md?.probabilidades ?? null, top = md?.classe ?? null;
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

V.addRenderer(() => { enviarQuadro(); painel(); }, 'cnn');
document.getElementById("cnnCsvBtn").onclick = baixarCsv;
V.cnn = {
  get estado() { return C.estado; }, get ultimo() { return C.ultimo; }, get leituras() { return leituras.length; },
  fresco, media, indice, conectar,
};
conectar();
