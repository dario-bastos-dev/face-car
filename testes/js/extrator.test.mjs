// npm test (node --test testes/js/*.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ear, aberturaBoca, angulosDaMatriz, matrizEmLinhas, Estabilidade,
  CalculadoraMetricas, RelogioWebcam, direcaoDoRosto, cabecalhoCsv, linhaCsv,
} from "../../demo-navegador/extrator.js";

const ler = (caminho) => JSON.parse(readFileSync(new URL(caminho, import.meta.url)));
const casos = ler("../casos/geometria.json");
const contrato = ler("../../contratos/metricas.v1.json");
const indices = ler("../../entrada/pontos_rosto.json");

const perto = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);

test("EAR", () => {
  for (const c of casos.ear) perto(ear(c.pontos), c.esperado, 1e-9, c.nome);
});

test("abertura da boca", () => {
  for (const c of casos.abertura_boca) {
    perto(aberturaBoca(c.pares, c.cantos[0], c.cantos[1]), c.esperado, 1e-9, c.nome);
  }
});

test("pose a partir da matriz em linhas e do formato achatado do MediaPipe", () => {
  for (const c of casos.pose) {
    const achatada = matrizEmLinhas({ rows: 4, columns: 4, data: c.dados_coluna });
    assert.deepEqual(achatada, c.matriz);
    const a = angulosDaMatriz(achatada);
    for (const k of ["yaw", "pitch", "roll"]) perto(a[k], c.esperado[k], 1e-6, k);
  }
});

test("estabilidade dá os mesmos valores que o Python", () => {
  const c = casos.estabilidade;
  const estab = new Estabilidade(c.parametros);
  for (const q of c.quadros) {
    const ref = q.pontos === null ? 0 : c.distancia_ref;
    perto(estab.atualizar(q.pontos, q.t_ms, ref), q.esperado, 1e-12, `t=${q.t_ms}`);
  }
});

test("CSV segue o contrato", () => {
  assert.equal(cabecalhoCsv(contrato), readFileSync(
    new URL("../../contratos/metricas.exemplo.csv", import.meta.url), "utf8").split("\n")[0]);
  const calc = new CalculadoraMetricas(casos.estabilidade.parametros, indices);
  const semRosto = calc.calcular(null, null, 100, 3, 9.06);
  assert.equal(linhaCsv(contrato, semRosto), "100,3,0,,,,,,,0.000,9.1");
});

test("relógio da webcam usa o instante de captura e começa no primeiro quadro", () => {
  const relogio = new RelogioWebcam();
  // O primeiro quadro foi capturado antes do callback: t_ms parte dele, não do callback.
  assert.deepEqual(relogio.quadro(1000, { captureTime: 990 }), { tMs: 0, captura: 990 });
  assert.deepEqual(relogio.quadro(1040, { captureTime: 1023.4 }), { tMs: 33, captura: 1023.4 });
});

test("relógio da webcam usa o now do callback quando não há captureTime", () => {
  const relogio = new RelogioWebcam();
  assert.deepEqual(relogio.quadro(500, {}), { tMs: 0, captura: 500 });
  assert.deepEqual(relogio.quadro(533, undefined), { tMs: 33, captura: 533 });
});

test("relógio da webcam descarta marcas que não avançam", () => {
  // O MediaPipe exige marcas de tempo estritamente crescentes.
  const relogio = new RelogioWebcam();
  relogio.quadro(110, { captureTime: 100 });
  assert.equal(relogio.quadro(120, { captureTime: 100.3 }), null);
  assert.equal(relogio.quadro(130, { captureTime: 90 }), null);
  assert.equal(relogio.quadro(140, { captureTime: 101 }).tMs, 1);
});

test("relógio da webcam não aceita captura depois do callback", () => {
  // A câmera falsa do Chrome chegou a informar captureTime ~2 ms à frente do now.
  const relogio = new RelogioWebcam();
  assert.deepEqual(relogio.quadro(1000, { captureTime: 1002 }), { tMs: 0, captura: 1000 });
});

test("direção do rosto bate com a terceira coluna da matriz", () => {
  for (const c of casos.pose) {
    const { yaw, pitch, roll } = c.esperado;
    const d = direcaoDoRosto(yaw, pitch, roll);
    const col = [0, 1, 2].map((i) => c.matriz[i][2]);
    const n = Math.hypot(...col);
    col.forEach((v, i) => perto(d[i], v / n, 1e-9, `eixo ${i}`));
  }
  assert.ok(direcaoDoRosto(0, 30, 0)[1] < 0, "cabeça baixa aponta para baixo");
});
