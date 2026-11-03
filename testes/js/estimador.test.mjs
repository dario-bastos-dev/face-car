import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimar, validarConfig } from "../../demo-navegador/estimador.js";

const config = JSON.parse(readFileSync(new URL("../../config/estimador.json", import.meta.url)));
const cfg = (patch = {}) => ({ ...structuredClone(config), ...patch });
const amostra = (t_ms, fechado = false, patch = {}) => ({
  t_ms, quadro: t_ms, rosto_visivel: true, ear_esq: fechado ? 0.05 : 0.30,
  ear_dir: fechado ? 0.05 : 0.30, abertura_boca: 0, yaw: 0, pitch: 0, roll: 0,
  confianca: 1, atraso_ms: 0, ...patch,
});
const serie = (fim, fechado = false, passo = 100) =>
  Array.from({ length: Math.floor(fim / passo) + 1 }, (_, i) => amostra(i * passo, fechado));
const perto = (a, b, nome = "valor") => assert.ok(Math.abs(a - b) <= 1e-9, `${nome}: ${a} != ${b}`);

function mesclar(base, patch) {
  const resultado = structuredClone(base);
  for (const [chave, valor] of Object.entries(patch)) {
    resultado[chave] = valor && typeof valor === "object" && !Array.isArray(valor)
      ? mesclar(resultado[chave] ?? {}, valor) : valor;
  }
  return resultado;
}

test("casos JSON compartilhados com Python", () => {
  const { casos } = JSON.parse(readFileSync(new URL("../casos/estimador.json", import.meta.url)));
  for (const caso of casos) {
    const resultado = estimar(caso.metricas, mesclar(config, caso.config_patch ?? {}), caso.agora_ms ?? null);
    for (const [chave, esperado] of Object.entries(caso.esperado)) {
      if (typeof esperado === "number") perto(resultado[chave], esperado, `${caso.nome}/${chave}`);
      else assert.equal(resultado[chave], esperado, `${caso.nome}/${chave}`);
    }
  }
});

test("sem amostras e uma amostra ainda não inventam duração", () => {
  for (const metricas of [[], [amostra(0)]]) {
    const r = estimar(metricas, config);
    assert.equal(r.indice, null);
    assert.equal(r.perclos, null);
    assert.equal(r.confianca, 0);
    assert.equal(r.tempo_valido_ms, 0);
  }
});

test("motorista alerta produz índice zero e confiança plena após aquecimento", () => {
  const r = estimar(serie(2000), config);
  assert.equal(r.indice, 0);
  assert.equal(r.perclos, 0);
  assert.equal(r.confianca, 1);
  assert.equal(r.cobertura, 1);
  assert.equal(r.amostras_validas, 20);
  perto(estimar(serie(500), config).confianca, 0.25);
});

test("fechamento contínuo satura o índice e deve ocorrer nos dois olhos", () => {
  const r = estimar(serie(3000, true), config);
  assert.equal(r.indice, 100);
  assert.equal(r.fechamento_continuo_ms, 3000);
  assert.equal(r.perclos, 1);
  assert.equal(estimar(serie(3000, true).map((m) => ({ ...m, ear_dir: 0.3 })), config).indice, 0);
});

test("fechamento de exatamente80% inclui o limiar sem erro de ponto flutuante", () => {
  const limite = serie(1000).map((m) => ({ ...m, ear_esq: 0.10, ear_dir: 0.10 }));
  assert.equal(estimar(limite, config).perclos, 1);
  assert.equal(estimar(limite.map((m) => ({ ...m, ear_esq: 0.10001 })), config).perclos, 0);
});

test("PERCLOS pondera tempo, não número de quadros", () => {
  const metricas = [amostra(0, true), amostra(100, true), amostra(400), amostra(900)];
  const r = estimar(metricas, cfg({ max_intervalo_ms: 1000, min_fechamento_ms: 0, min_evidencia_ms: 100 }));
  perto(r.perclos, 400 / 900);
  perto(r.indice, 100 * 400 / 900);
  assert.equal(r.tempo_fechado_ms, 400);
});

test("piscada curta é excluída e duração mínima exata é incluída", () => {
  const curto = [amostra(0, true), amostra(100, true), amostra(200), amostra(300)];
  const exato = [amostra(0, true), amostra(100, true), amostra(200, true), amostra(300)];
  assert.equal(estimar(curto, config).tempo_fechado_ms, 0);
  assert.equal(estimar(curto, config).fechamento_continuo_ms, 0);
  assert.equal(estimar(exato, config).tempo_fechado_ms, 300);
});

test("episódio antes do início da janela é qualificado antes de recortar", () => {
  const metricas = [amostra(0, true), amostra(200, true), amostra(400, true), amostra(600), amostra(800), amostra(1000)];
  const r = estimar(metricas, cfg({ janela_s: 0.5, min_evidencia_ms: 500, saturacao_fechamento_ms: 500 }));
  assert.equal(r.tempo_valido_ms, 500);
  assert.equal(r.tempo_fechado_ms, 100);
  perto(r.perclos, 0.2);
});

test("fechamento contínuo é limitado à janela", () => {
  const r = estimar(serie(2000, true), cfg({ janela_s: 1, min_evidencia_ms: 500, saturacao_fechamento_ms: 500 }));
  assert.equal(r.fechamento_continuo_ms, 1000);
  assert.equal(r.tempo_fechado_ms, 1000);
});

test("lacunas não viram olhos abertos e reduzem cobertura", () => {
  const r = estimar([amostra(0, true), amostra(100, true), amostra(1000), amostra(1100)], config);
  assert.equal(r.tempo_valido_ms, 450);
  assert.equal(r.tempo_fechado_ms, 350);
  perto(r.perclos, 350 / 450);
  perto(r.cobertura, 450 / 1100);
  perto(r.confianca, (450 / 1100) * (450 / 2000));
});

test("lacuna interrompe fechamento contínuo e impede unir piscadas", () => {
  const r = estimar([amostra(0, true), amostra(1000, true)], config, 1100);
  assert.equal(r.tempo_fechado_ms, 0);
  assert.equal(r.fechamento_continuo_ms, 100);
});

test("observação mais recente inválida zera confiança mesmo com histórico bom", () => {
  const variantes = [
    { rosto_visivel: false }, { rosto_visivel: "1" }, { ear_esq: null }, { ear_dir: NaN },
    { ear_esq: -0.1 }, { ear_esq: 1.1 }, { confianca: 0.49 }, { confianca: Infinity },
    { confianca: true }, { confianca: 1.1 }, { atraso_ms: null }, { atraso_ms: -1 }, { atraso_ms: 501 },
  ];
  for (const patch of variantes) {
    const metricas = serie(2000);
    metricas[metricas.length - 1] = amostra(2000, false, patch);
    const r = estimar(metricas, config);
    assert.equal(r.confianca, 0, JSON.stringify(patch));
    assert.equal(r.fechamento_continuo_ms, 0);
  }
});

test("expiração de amostra e retenção explícita até agora", () => {
  const metricas = serie(2000, true);
  assert.equal(estimar(metricas, config, 2250).confianca, 1);
  assert.equal(estimar(metricas, config, 2251).confianca, 0);
  assert.equal(estimar(metricas, config, 2251).fechamento_continuo_ms, 0);
  assert.equal(estimar(metricas, config, 33000).indice, null);
});

test("confiança do rastreio é ponderada pelos intervalos", () => {
  const r = estimar([amostra(0, false, { confianca: 0.5 }), amostra(100), amostra(300)],
    cfg({ max_intervalo_ms: 500, min_evidencia_ms: 300 }));
  perto(r.confianca, 250 / 300);
});

test("timestamp duplicado, invertido, inválido e futuro são recusados", () => {
  for (const t of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, true, "2", null]) {
    assert.throws(() => estimar([amostra(t)], config));
    if (t !== null) assert.throws(() => estimar([], config, t));
  }
  assert.throws(() => estimar([amostra(0), amostra(0)], config));
  assert.throws(() => estimar([amostra(1), amostra(0)], config));
  assert.throws(() => estimar([amostra(2)], config, 1));
  assert.throws(() => estimar({}, config));
});

test("configuração inválida é recusada e chamadas não alteram argumentos", () => {
  for (const patch of [
    { janela_s: 0 }, { max_intervalo_ms: 0 }, { max_intervalo_ms: 31000 },
    { min_evidencia_ms: 0 }, { min_fechamento_ms: -1 }, { saturacao_fechamento_ms: 0 },
    { max_atraso_ms: -1 }, { confianca_rastreio_minima: 2 },
    { olhos: { ...config.olhos, fechamento_limiar: 0 } },
    { olhos: { ...config.olhos, ear_aberto_esq: config.olhos.ear_fechado_esq } },
  ]) assert.throws(() => validarConfig(cfg(patch)), JSON.stringify(patch));
  const metricas = serie(1000, true), c = cfg(), antes = JSON.stringify([metricas, c]);
  const a = estimar(metricas, c), b = estimar(metricas, c);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([metricas, c]), antes);
});
