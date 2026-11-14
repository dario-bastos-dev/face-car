import test from "node:test";
import assert from "node:assert/strict";
import { MonitorHibrido } from "../../simulador/js/monitor-hibrido.js";

const LIMIARES = { ear_olho_fechado: 0.18, olhos_fechados_alerta_ms: 1000 };

test("fecha apenas após o período configurado e sinaliza a reabertura", () => {
  const m = new MonitorHibrido(LIMIARES);
  assert.equal(m.registrar(0, true, 0.3).alerta, false);
  assert.deepEqual(m.registrar(500, true, 0.1).eventos, []);
  assert.deepEqual(m.registrar(1000, true, 0.1).eventos, []);
  assert.deepEqual(m.registrar(1500, true, 0.1).eventos, ["olhos fechados por período prolongado"]);
  assert.equal(m.registrar(1500, true, 0.1).alerta, true);
  assert.deepEqual(m.registrar(1600, true, 0.3).eventos, ["olhos reabertos"]);
  assert.equal(m.registrar(1700, true, 0.3).fechamentoContinuoMs, 0);
});

test("ausência do rosto invalida e não preserva fechamento antigo", () => {
  const m = new MonitorHibrido(LIMIARES);
  m.registrar(0, true, 0.1);
  const semRosto = m.registrar(1200, false, null);
  assert.equal(semRosto.valido, false);
  const retorno = m.registrar(1300, true, 0.3);
  assert.equal(retorno.alerta, false);
  assert.equal(retorno.fechamentoContinuoMs, 0);
});


test("perda curta do rosto não zera o fechamento em andamento", () => {
  const m = new MonitorHibrido({ ...LIMIARES, perda_rosto_tolerancia_ms: 1000 });
  m.registrar(0, true, 0.1);
  m.registrar(1200, true, 0.1);
  const perda = m.registrar(1600, false, null);
  assert.equal(perda.valido, false);
  assert.equal(perda.emEspera, true);
  assert.equal(perda.alerta, true);
  assert.equal(m.registrar(2000, true, 0.1).fechamentoContinuoMs, 2000);
});

test("perda longa do rosto reinicia o fechamento", () => {
  const m = new MonitorHibrido({ ...LIMIARES, perda_rosto_tolerancia_ms: 1000 });
  m.registrar(0, true, 0.1);
  assert.equal(m.registrar(1500, false, null).emEspera, false);
  assert.equal(m.registrar(1600, true, 0.1).fechamentoContinuoMs, 0);
});
