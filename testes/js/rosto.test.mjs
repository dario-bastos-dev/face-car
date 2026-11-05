// Olhos, boca, cabeça e olhar no navegador (simulador/js/rosto.js): os mesmos casos de
// testes/entrada/test_rosto.py, para o simulador seguir a análise em Python.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MonitorRosto, angulosDaDirecao, descrever, direcaoDaCabeca, olharDaIris } from "../../simulador/js/rosto.js";

const INDICES = JSON.parse(readFileSync(new URL("../../entrada/pontos_rosto.json", import.meta.url), "utf8"));
const perto = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const rad = (g) => (g * Math.PI) / 180;
// matriz 4x4 em linhas a partir de uma rotação 3x3
const matriz = (r) => [[...r[0], 0], [...r[1], 0], [...r[2], 0], [0, 0, 0, 1]];
const giraY = (g) => [[Math.cos(rad(g)), 0, Math.sin(rad(g))], [0, 1, 0], [-Math.sin(rad(g)), 0, Math.cos(rad(g))]];
const giraX = (g) => [[1, 0, 0], [0, Math.cos(rad(g)), -Math.sin(rad(g))], [0, Math.sin(rad(g)), Math.cos(rad(g))]];

test("cabeça de frente, virada e inclinada", () => {
  const d = direcaoDaCabeca(matriz([[1, 0, 0], [0, 1, 0], [0, 0, 1]]));
  [0, 0, 1].forEach((v, i) => perto(d[i], v));
  const [h] = angulosDaDirecao(direcaoDaCabeca(matriz(giraY(30))));
  perto(h, 30);
  const [h2, v2] = angulosDaDirecao(direcaoDaCabeca(matriz(giraX(20))));
  perto(h2, 0); perto(v2, -20);
  const escalada = direcaoDaCabeca(matriz(giraY(30).map((l) => l.map((x) => 1.7 * x))));
  direcaoDaCabeca(matriz(giraY(30))).forEach((v, i) => perto(escalada[i], v));
});

test("descrever do ponto de vista do motorista", () => {
  for (const [h, v, esperado] of [[0, 0, "frente"], [30, 0, "esquerda"], [-30, 0, "direita"], [0, -20, "baixo"],
    [0, 20, "cima"], [25, -20, "baixo e esquerda"], [10, -10, "frente"]]) assert.equal(descrever(h, v, 15), esperado);
});

test("olhar pela posição das íris", () => {
  const pts = Array.from({ length: 478 }, () => [0, 0]);
  pts[33] = [100, 100]; pts[133] = [140, 100]; pts[468] = [130, 100];
  pts[362] = [160, 100]; pts[263] = [200, 100]; pts[473] = [190, 106];
  const [dx, dy] = olharDaIris(pts, INDICES);
  perto(dx, 0.5); perto(dy, 0.15);
});

const LIMIARES = { ear_olho_fechado: 0.18, piscada_max_ms: 400, olhos_fechados_alerta_ms: 1000,
  abertura_boca_aberta: 0.4, bocejo_min_ms: 1500 };
const ABERTO = 0.3, FECHADO = 0.05, BOCA_FECHADA = 0.02, BOCA_ABERTA = 0.6;
const sequencia = (m, passos) => passos.flatMap(([t, ear, boca]) => m.registrar(t, ear, boca, "frente").eventos.map((e) => [t, e]));
const faixa = (a, b, passo) => Array.from({ length: Math.ceil((b - a) / passo) }, (_, i) => a + i * passo);

test("piscada, olhos fechados e reabertos", () => {
  assert.deepEqual(sequencia(new MonitorRosto(LIMIARES),
    [[0, ABERTO, BOCA_FECHADA], [50, FECHADO, BOCA_FECHADA], [100, FECHADO, BOCA_FECHADA], [200, ABERTO, BOCA_FECHADA]]),
  [[200, "piscada (0,15 s)"]]);
  const passos = [[0, ABERTO, BOCA_FECHADA], ...faixa(100, 1400, 100).map((t) => [t, FECHADO, BOCA_FECHADA]), [1400, ABERTO, BOCA_FECHADA]];
  assert.deepEqual(sequencia(new MonitorRosto(LIMIARES), passos),
    [[1100, "olhos fechados há mais de 1 s"], [1400, "olhos reabertos após 1,30 s"]]);
});

test("bocejo só com a boca aberta por tempo suficiente; sem rosto recomeça", () => {
  const m = new MonitorRosto(LIMIARES);
  assert.deepEqual(sequencia(m, [...faixa(0, 600, 100).map((t) => [t, ABERTO, BOCA_ABERTA]), [600, ABERTO, BOCA_FECHADA]]), []);
  assert.deepEqual(sequencia(m, [...faixa(1000, 3200, 100).map((t) => [t, ABERTO, BOCA_ABERTA]), [3200, ABERTO, BOCA_FECHADA]]),
    [[2500, "bocejo"]]);
  m.registrar(4000, FECHADO, BOCA_FECHADA);
  assert.equal(m.registrar(4100, null, null).olhos, null);
  assert.deepEqual(m.registrar(4200, ABERTO, BOCA_FECHADA).eventos, []);
});
