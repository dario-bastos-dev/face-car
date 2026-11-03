// Canal de sinal da Parte 3. Aplica ao simulador as mensagens do contrato sinal.v1,
// venham do estimador rodando na própria página (canal "ia", por chamada de função),
// do estimador em Python (canal "websocket") ou de um arquivo gravado (canal "replay").
// Só um canal comanda por vez; os botões manuais fecham o canal.
import { Receptor } from "./receptor.js";

const V = window.VIGIA;
const $ = (id) => document.getElementById(id);
const NIVEL = { NORMAL: "normal", ATENCAO: "attention", ALERTA: "critical", INTERVENCAO: "intervention" };
const NOMES = { ia: "IA na página", websocket: "WebSocket", replay: "Replay" };

const receptor = new Receptor();
let canal = null, ws = null, timers = [];

function abrirCanal(nome, sessao = null) {
  pararReplay();
  if (nome !== "websocket") fecharWS(false);
  canal = nome;
  receptor.reiniciar(sessao);
  V.state.channel = nome;
  V.refreshUI();
  V.log(`Canal de sinal: ${NOMES[nome]}`, "connection");
}
// degradar: o canal caiu sem um comando novo; se havia alerta ativo, vai para
// "sistema degradado" e para de frear (nunca mantém uma intervenção sem sinal).
function fecharCanal(motivo, degradar = false) {
  if (!canal) return;
  pararReplay();
  if (canal === "websocket") fecharWS(false);
  canal = null;
  receptor.reiniciar(null);
  V.state.channel = null;
  V.refreshUI();
  if (motivo) V.log(motivo, "connection");
  if (degradar && V.effectiveLevel() !== "normal") V.setDegraded("Canal de sinal encerrado: sistema degradado, sem frenagem");
}

// Entrada única de mensagens. origem: "ia" | "websocket" | "replay".
function receber(m, origem) {
  if (origem !== canal) return "ignorada";
  const r = receptor.receber(m, performance.now());
  if (r.status === "aceita") {
    if (r.comando) aplicar(r.comando, origem);
    else V.log("Heartbeat aceito", "heartbeat", { source: origem, received_seq: m.seq }, true);
  } else {
    V.log(`Mensagem ignorada: ${r.status}${r.motivo ? " (" + r.motivo + ")" : ""}`, "protocol", { source: origem, received_seq: m?.seq ?? null });
  }
  if (origem === "websocket") enviar({ tipo: "status_entrega", sessao: receptor.sessao, seq: m?.seq ?? null, status: r.status });
  return r.status;
}
function aplicar(m, origem) {
  V.state.lastSignal = { estado: m.estado, indice: m.indice, confianca: m.confianca, origem };
  if (m.estado === "DEGRADADO") V.setDegraded("Estimador sem evidência suficiente: nenhuma frenagem aplicada");
  else V.setLevel(NIVEL[m.estado], origem);
}

// Sem mensagem válida antes de vencer a última: sistema degradado, sem frear.
setInterval(() => {
  if (canal && receptor.canalPerdido(performance.now()) && !V.state.degraded) {
    V.setDegraded("Sem heartbeat do estimador: sistema degradado, sem frenagem");
  }
}, 200);

/* ---------- WebSocket (estimador em Python como servidor) ---------- */
function enviar(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ ...obj, ts_local: Math.round(performance.now()) })); } catch { /* conexão caindo */ }
  }
}
function fecharWS(anunciar = true) {
  if (!ws) return;
  const w = ws; ws = null; w.onclose = null; w.close();
  if (anunciar) V.log("WebSocket desconectado", "connection");
}
function conectarWS(url) {
  if (ws) { fecharWS(); fecharCanal("Canal de sinal: WebSocket encerrado", true); return; }
  if (!/^wss?:\/\//i.test(url)) { V.log("URL do WebSocket inválida", "error"); return; }
  let w;
  try { w = new WebSocket(url); } catch (e) { V.log("Erro ao criar WebSocket: " + e.message, "error"); return; }
  ws = w;
  V.log("Conectando ao estimador em " + url, "connection");
  w.onopen = () => {
    if (ws !== w) return;
    abrirCanal("websocket");
  };
  w.onmessage = (e) => {
    for (const linha of String(e.data).split(/\r?\n/)) {
      if (!linha.trim()) continue;
      let m; try { m = JSON.parse(linha); } catch { V.log("JSON inválido recebido", "protocol"); continue; }
      receber(m, "websocket");
    }
  };
  w.onclose = () => {
    if (ws !== w) return;
    ws = null;
    if (canal === "websocket") { canal = null; V.state.channel = null; V.setDegraded("Conexão com o estimador perdida: sistema degradado, sem frenagem"); }
    V.log("WebSocket desconectado", "connection");
  };
  w.onerror = () => V.log("Erro de conexão com o estimador: verifique o servidor local", "error");
}

/* ---------- replay de mensagens gravadas ---------- */
function pararReplay() { timers.forEach(clearTimeout); timers = []; }
// Reproduz mensagens sinal.v1 respeitando o intervalo entre os ts.
function reproduzir(mensagens, nome) {
  if (!mensagens.length) { V.log("Nenhuma mensagem para reproduzir", "error"); return; }
  abrirCanal("replay");
  const t0 = mensagens[0].ts;
  V.log(`Replay ${nome}: ${mensagens.length} mensagens`, "replay");
  for (const m of mensagens) timers.push(setTimeout(() => receber(m, "replay"), Math.max(0, m.ts - t0)));
  const fim = mensagens[mensagens.length - 1].ts - t0;
  timers.push(setTimeout(() => fecharCanal(`Replay ${nome} concluído`), fim + 300));
}
async function importarReplay(arquivo) {
  if (!arquivo) return;
  try {
    const texto = await arquivo.text();
    let lista;
    if (arquivo.name.toLowerCase().endsWith(".jsonl")) lista = texto.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    else { const d = JSON.parse(texto); lista = Array.isArray(d) ? d : []; }
    if (lista.length > 20000) throw Error("Replay limitado a 20 000 mensagens");
    reproduzir(lista, "de " + arquivo.name);
  } catch (e) { V.log("Erro no arquivo de replay: " + e.message, "error"); }
  finally { $("replayFile").value = ""; }
}

// Resposta do motorista ("Estou atento"): vai para quem estiver comandando.
V.on("resposta", () => {
  if (canal === "websocket") enviar({ tipo: "resposta_motorista", sessao: receptor.sessao, acao: "confirmou_atencao", veiculo: V.state.vehicle });
  if (canal === "ia") V.ia?.responder();
});

// Estimador em Python: abra a página com ?ws=ws://localhost:8765
const wsInicial = new URLSearchParams(location.search).get("ws");
if (wsInicial) conectarWS(wsInicial);

V.sinal = {
  receber, abrirCanal, fecharCanal, conectarWS, importarReplay,
  get canal() { return canal; }, receptor,
};
