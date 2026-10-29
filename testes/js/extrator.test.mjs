// node --test testes/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ear, aberturaBoca, angulosDaMatriz, matrizEmLinhas, Estabilidade,
  CalculadoraMetricas, cabecalhoCsv, linhaCsv,
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
