// Receptor do contrato sinal.v1 (simulador/js/receptor.js) e modelo da Parte 4 no navegador.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Receptor, validarSinal } from "../../simulador/js/receptor.js";
import { atributosDaJanela, preverModelo } from "../../simulador/js/modelo.js";

const msg = (extra = {}) => ({ versao: 1, sessao: "s1", tipo: "acao", seq: 1, ts: 0, ttl: 2000,
  estado: "NORMAL", nivel: 0, acao: "monitorar", indice: 10, confianca: 0.9, ...extra });

test("aceita mensagem válida e devolve o comando", () => {
  const r = new Receptor();
  const res = r.receber(msg(), 1000);
  assert.equal(res.status, "aceita");
  assert.equal(res.comando.estado, "NORMAL");
});

test("rejeita esquema inválido e estado incoerente com nível/ação", () => {
  assert.match(validarSinal({ ...msg(), extra: 1 }), /desconhecido/);
  assert.match(validarSinal(msg({ nivel: 2 })), /incoerente/);
  assert.match(validarSinal(msg({ versao: 2 })), /versao/);
  assert.match(validarSinal(msg({ indice: 120 })), /indice/);
  assert.equal(validarSinal(msg({ estado: "DEGRADADO", acao: "sistema_degradado", indice: null, confianca: 0 })), null);
  assert.equal(new Receptor().receber(msg({ acao: "aviso_visual" }), 0).status, "invalida");
});

test("heartbeat é aceito mas nunca vira comando", () => {
  const res = new Receptor().receber(msg({ tipo: "heartbeat", estado: "INTERVENCAO", nivel: 3, acao: "desacelerar_simulado" }), 0);
  assert.equal(res.status, "aceita");
  assert.equal(res.comando, null);
});

test("descarta fora de ordem, vencida e de outra sessão", () => {
  const r = new Receptor();
  assert.equal(r.receber(msg({ seq: 5, ts: 0 }), 100).status, "aceita");      // relógio alinhado: agora = 0
  assert.equal(r.receber(msg({ seq: 5, ts: 50 }), 150).status, "fora_de_ordem");
  assert.equal(r.receber(msg({ seq: 4, ts: 60 }), 160).status, "fora_de_ordem");
  assert.equal(r.receber(msg({ seq: 6, ts: 100 }), 100 + 2100).status, "vencida"); // agora 2100 >= 100 + 2000
  assert.equal(r.receber(msg({ seq: 7, sessao: "s2", ts: 3000 }), 3100).status, "outra_sessao");
  r.reiniciar("s2");
  assert.equal(r.receber(msg({ seq: 1, sessao: "s2", ts: 0 }), 9000).status, "aceita");
});

test("canal perdido quando a última mensagem aceita vence", () => {
  const r = new Receptor();
  assert.equal(r.canalPerdido(0), false); // sem sessão ainda
  r.receber(msg({ ts: 1000, ttl: 2000 }), 5000); // offset 4000
  assert.equal(r.canalPerdido(5000 + 1999), false);
  assert.equal(r.canalPerdido(5000 + 2000), true);
});

test("todas as mensagens da Parte 2 (exemplos/parte2/sinais.jsonl) são aceitas em tempo real", () => {
  const linhas = readFileSync(new URL("../../exemplos/parte2/sinais.jsonl", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const r = new Receptor(), t0 = 10000;
  const status = linhas.map((m) => r.receber(m, t0 + m.ts).status);
  assert.deepEqual([...new Set(status)], ["aceita"]);
});

test("modelo da Parte 4: atributos da janela e probabilidade logística", () => {
  const hist = [0, 100, 200].map((t) => ({ t_ms: t, rosto_visivel: true, ear_esq: 0.3, ear_dir: 0.2, abertura_boca: 0.1 }));
  const x = atributosDaJanela(hist, { t_ms: 200, perclos: 0.5 }, 30000);
  for (const [k, v] of Object.entries({ ear: 0.25, perclos: 0.5, boca: 0.1 })) assert.ok(Math.abs(x[k] - v) < 1e-12, k);
  const modelo = { atributos: ["ear", "perclos", "boca"], media: [0.25, 0, 0], escala: [1, 1, 1], coeficientes: [0, 2, 0], intercepto: -1 };
  assert.ok(Math.abs(preverModelo(modelo, hist, { t_ms: 200, perclos: 0.5 }) - 0.5) < 1e-12); // z = -1 + 2*0.5 = 0
  assert.equal(preverModelo(null, hist, { perclos: 0.5 }), null);
  assert.equal(preverModelo(modelo, [], { perclos: null }), null);
});
