// Receptor do contrato sinal.v1 (simulador/js/receptor.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Receptor, validarSinal } from "../../simulador/js/receptor.js";
import { estimar } from "../../demo-navegador/estimador.js";
import { estadoInicial, transicionar } from "../../demo-navegador/politica.js";
import { estadoEmissorInicial, emitir } from "../../demo-navegador/mensagens.js";

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

// Mensagens geradas pela Parte 2 como na página (ia.js): 20 s de olhos abertos e depois
// fechados, a 30 quadros/s, com ticks de 100 ms. Todas devem ser aceitas, e o estado precisa
// sair de NORMAL até ALERTA.
test("mensagens da Parte 2 geradas em tempo real são todas aceitas", () => {
  const config = JSON.parse(readFileSync(new URL("../../config/estimador.json", import.meta.url), "utf8"));
  const retencao = config.janela_s * 1000 + config.min_fechamento_ms + config.max_intervalo_ms;
  const historico = [];
  for (let t = 0, q = 0; t <= 40000; t += 33, q++) {
    const ear = t > 20000 ? 0.04 : 0.3;
    historico.push({ t_ms: t, quadro: q, rosto_visivel: true, ear_esq: ear, ear_dir: ear, abertura_boca: 0.02,
      yaw: 0, pitch: 0, roll: 0, confianca: 0.95, atraso_ms: 10 });
  }
  let estado = estadoInicial(), emissor = estadoEmissorInicial("teste");
  const mensagens = [];
  for (let t = 0; t <= 40000; t += 100) {
    const e = estimar(historico.filter((r) => r.t_ms <= t && r.t_ms > t - retencao), config, t);
    estado = transicionar(estado, e, t, config, false);
    let novas;
    [emissor, novas] = emitir(emissor, estado, e, t, config);
    mensagens.push(...novas);
  }
  const r = new Receptor(), t0 = 10000;
  assert.deepEqual([...new Set(mensagens.map((m) => r.receber(m, t0 + m.ts).status))], ["aceita"]);
  const estados = new Set(mensagens.filter((m) => m.tipo === "acao").map((m) => m.estado));
  for (const e of ["NORMAL", "ATENCAO", "ALERTA"]) assert.ok(estados.has(e), e);
});
