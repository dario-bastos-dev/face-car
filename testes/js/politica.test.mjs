import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {estadoInicial, transicionar} from '../../demo-navegador/politica.js';
import {estadoEmissorInicial, emitir} from '../../demo-navegador/mensagens.js';

const config = JSON.parse(readFileSync(new URL('../../config/estimador.json', import.meta.url)));
const casos = JSON.parse(readFileSync(new URL('../casos/politica.json', import.meta.url))).casos;
const casosMensagens = JSON.parse(readFileSync(new URL('../casos/mensagens.json', import.meta.url))).casos;
for (const caso of casosMensagens) test(`mensagens compartilhadas: ${caso.nome}`, () => {
  const cfg = structuredClone(config);
  if (caso.mensagens) cfg.mensagens = caso.mensagens;
  let emissor = estadoEmissorInicial('teste-compartilhado');
  for (const passo of caso.passos) {
    const estimativa = {t_ms: passo.estimativa_t_ms ?? passo.t_ms, indice: passo.indice, confianca: passo.confianca};
    const [novo, mensagens] = emitir(emissor, {nome: passo.estado}, estimativa, passo.t_ms, cfg);
    assert.deepEqual(mensagens, passo.esperadas);
    emissor = novo;
  }
});
for (const caso of casos) test(`política: ${caso.nome}`, () => {
  let estado = {...estadoInicial(), nome: caso.inicial, inicio_ms: 0,
    prazo_resposta_em_ms: caso.inicial === 'ALERTA' ? config.politica.prazo_resposta_ms : null};
  for (const passo of caso.passos) {
    const estimativa = {t_ms: passo.estimativa_t_ms ?? passo.t_ms, indice: passo.indice, confianca: passo.confianca};
    const antes = structuredClone([estado, estimativa, config]);
    const proximo = transicionar(estado, estimativa, passo.t_ms, config, passo.resposta_motorista ?? false);
    assert.equal(proximo.nome, passo.estado_esperado, JSON.stringify(passo));
    assert.deepEqual([estado, estimativa, config], antes);
    estado = proximo;
  }
});
test('política rejeita tempo regressivo e degrada NaN', () => {
  const estado = {...estadoInicial(), nome: 'INTERVENCAO', ultimo_ms: 100};
  assert.throws(() => transicionar(estado, {t_ms: 99, indice: 50, confianca: 1}, 99, config));
  assert.equal(transicionar(estado, {t_ms: 100, indice: NaN, confianca: 1}, 100, config).nome, 'DEGRADADO');
});
test('mensagens: agenda, seq global, mudança e evidência expirada', () => {
  let emissor = estadoEmissorInicial('teste');
  const politica = {nome: 'INTERVENCAO'};
  const estimativa = t => ({t_ms: t, indice: 80, confianca: 1});
  const antes = structuredClone(emissor);
  let [novo, mensagens] = emitir(emissor, politica, estimativa(0), 0, config);
  assert.deepEqual(emissor, antes);
  assert.deepEqual(mensagens.map(m => [m.seq, m.tipo]), [[1, 'acao'], [2, 'heartbeat']]);
  assert.ok(mensagens.every(m => m.ttl === 2000 && m.acao === 'desacelerar_simulado'));
  emissor = novo;
  [novo, mensagens] = emitir(emissor, politica, estimativa(0), 251, config);
  assert.deepEqual(mensagens.map(m => [m.seq, m.estado, m.acao]), [[3, 'DEGRADADO', 'sistema_degradado']]);
  assert.equal(mensagens[0].indice, null);
  [novo, mensagens] = emitir(novo, politica, estimativa(0), 500, config);
  assert.deepEqual(mensagens.map(m => [m.seq, m.tipo, m.estado]), [[4, 'heartbeat', 'DEGRADADO']]);
  assert.throws(() => emitir(novo, politica, estimativa(0), 499, config));
});
test('configuração não pode remover degradação nem ultrapassar TTL', () => {
  const estimativa = {t_ms: 0, indice: 0, confianca: 1};
  for (const mudar of [
    c => c.politica.confianca_minima = 0,
    c => c.politica.confianca_minima = NaN,
    c => c.politica.transicoes[0].duracao_ms = 1,
    c => c.politica.transicoes[3].para = 'INTERVENCAO',
    c => c.politica.transicoes[1].limiar = 101,
    c => c.politica.transicoes[1].duracao_ms = -1,
    c => c.politica.prazo_resposta_ms = 0,
  ]) {
    const cfg = structuredClone(config); mudar(cfg);
    assert.throws(() => transicionar(estadoInicial(), estimativa, 0, cfg));
  }
  for (const mudar of [
    c => c.mensagens.ttl_ms = 0,
    c => c.mensagens.heartbeat_ms = 2000,
    c => c.mensagens.renovar_acao_ms = 2001,
    c => c.mensagens.heartbeat_ms = 0.5,
  ]) {
    const cfg = structuredClone(config); mudar(cfg);
    assert.throws(() => emitir(estadoEmissorInicial(), {nome: 'NORMAL'}, estimativa, 0, cfg));
  }
});
