// Receptor do contrato contratos/sinal.v1.json (Parte 3). Puro: sem DOM, rede ou relógio
// próprio, para rodar também no Node (testes/js/receptor.test.mjs).
//
// - valida o esquema e a coerência estado ↔ nível ↔ ação;
// - aceita uma sessão por vez; outra sessão exige reiniciar() explícito;
// - descarta mensagens fora de ordem (seq não crescente) e vencidas (agora >= ts + ttl);
// - heartbeat só informa a saúde do canal e nunca vira comando;
// - sem mensagem válida até vencer a última, o canal é considerado perdido.
//
// O ts das mensagens está no relógio monotônico da sessão de quem emite. O receptor
// alinha esse relógio ao local na primeira mensagem aceita da sessão (offset).

export const ACOES = {
  NORMAL: [0, "monitorar"],
  ATENCAO: [1, "aviso_visual"],
  ALERTA: [2, "alarme_sonoro"],
  INTERVENCAO: [3, "desacelerar_simulado"],
  DEGRADADO: [0, "sistema_degradado"],
};
const CAMPOS = ["versao", "sessao", "tipo", "seq", "ts", "ttl", "estado", "nivel", "acao", "indice", "confianca"];
const inteiro = (x, min) => Number.isSafeInteger(x) && x >= min;

// Devolve null se a mensagem segue o contrato, ou o motivo da recusa.
export function validarSinal(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "não é objeto";
  for (const c of CAMPOS) if (!(c in m)) return `campo ausente: ${c}`;
  for (const c of Object.keys(m)) if (!CAMPOS.includes(c)) return `campo desconhecido: ${c}`;
  if (m.versao !== 1) return "versao deve ser 1";
  if (typeof m.sessao !== "string" || !m.sessao) return "sessao inválida";
  if (m.tipo !== "acao" && m.tipo !== "heartbeat") return "tipo inválido";
  if (!inteiro(m.seq, 1)) return "seq inválido";
  if (!inteiro(m.ts, 0)) return "ts inválido";
  if (!inteiro(m.ttl, 1)) return "ttl inválido";
  const esperado = ACOES[m.estado];
  if (!esperado) return "estado inválido";
  if (m.nivel !== esperado[0] || m.acao !== esperado[1]) return "nível ou ação incoerente com o estado";
  if (m.indice !== null && !(typeof m.indice === "number" && m.indice >= 0 && m.indice <= 100)) return "indice inválido";
  if (!(typeof m.confianca === "number" && m.confianca >= 0 && m.confianca <= 1)) return "confianca inválida";
  return null;
}

export class Receptor {
  constructor() { this.reiniciar(null); }

  // Nova sessão (ou null para aceitar a primeira que chegar). Esquece seq e relógio.
  reiniciar(sessao = null) {
    this.sessao = sessao;
    this.ultimoSeq = 0;
    this.offset = null;      // agoraLocal - ts da sessão
    this.validoAte = null;   // ts + ttl da última mensagem aceita, no relógio da sessão
    this.ultima = null;
  }

  agoraSessao(agoraLocalMs) { return this.offset === null ? null : agoraLocalMs - this.offset; }

  // Processa uma mensagem. Devolve { status, motivo?, comando? }.
  // status: aceita | invalida | outra_sessao | fora_de_ordem | vencida
  receber(m, agoraLocalMs) {
    const motivo = validarSinal(m);
    if (motivo) return { status: "invalida", motivo };
    if (this.sessao === null) this.sessao = m.sessao;
    if (m.sessao !== this.sessao) return { status: "outra_sessao" };
    if (m.seq <= this.ultimoSeq) return { status: "fora_de_ordem" };
    if (this.offset === null) this.offset = agoraLocalMs - m.ts;
    if (this.agoraSessao(agoraLocalMs) >= m.ts + m.ttl) return { status: "vencida" };
    this.ultimoSeq = m.seq;
    this.validoAte = Math.max(this.validoAte ?? 0, m.ts + m.ttl);
    this.ultima = m;
    return { status: "aceita", comando: m.tipo === "acao" ? m : null };
  }

  // Canal perdido: havia sessão e a validade da última mensagem aceita já venceu.
  canalPerdido(agoraLocalMs) {
    return this.validoAte !== null && this.agoraSessao(agoraLocalMs) >= this.validoAte;
  }
}
