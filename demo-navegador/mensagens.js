/** Emissão pura de ações e heartbeat, sem câmera ou transporte. */
import {ESTADOS, evidenciaValida, validarPolitica, validarTempo} from './politica.js';
const ACOES = {NORMAL: [0, 'monitorar'], ATENCAO: [1, 'aviso_visual'],
  ALERTA: [2, 'alarme_sonoro'], INTERVENCAO: [3, 'desacelerar_simulado'],
  DEGRADADO: [0, 'sistema_degradado']};
export function validarMensagens(config) {
  const m = config.mensagens;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Configuração mensagens ausente');
  for (const chave of ['ttl_ms', 'heartbeat_ms', 'renovar_acao_ms']) {
    validarTempo(m[chave], chave);
    if (m[chave] === 0) throw new Error(`${chave} deve ser positivo`);
  }
  if (Math.max(m.heartbeat_ms, m.renovar_acao_ms) >= m.ttl_ms) throw new Error('Heartbeat e renovação devem ocorrer antes do TTL');
  return config;
}
export function estadoEmissorInicial(sessao = 'replay') {
  if (typeof sessao !== 'string' || !sessao.trim()) throw new Error('sessao deve ser string não vazia');
  return {sessao, seq: 0, ultimo_ms: null, ultima_acao_ms: null, ultimo_heartbeat_ms: null, ultimo_estado: null};
}
export function emitir(estadoEmissor, estadoPolitica, estimativa, agoraMs, config) {
  validarPolitica(config);
  validarMensagens(config);
  validarTempo(agoraMs);
  validarTempo(agoraMs + config.mensagens.ttl_ms, 'expiracao');
  if (!ESTADOS.includes(estadoPolitica.nome)) throw new Error('Estado desconhecido');
  const novo = {...estadoEmissor}, m = config.mensagens;
  if (novo.ultimo_ms !== null && agoraMs < novo.ultimo_ms) throw new Error('Tempo do emissor fora de ordem');
  novo.ultimo_ms = agoraMs;
  const valido = evidenciaValida(estimativa, agoraMs, config);
  const nome = valido ? estadoPolitica.nome : 'DEGRADADO';
  const [nivel, acao] = ACOES[nome], mensagens = [];
  function adicionar(tipo) {
    if (novo.seq >= Number.MAX_SAFE_INTEGER) throw new Error('Sequência esgotada; inicie outra sessão');
    novo.seq++;
    mensagens.push({versao: 1, sessao: novo.sessao, tipo, seq: novo.seq, ts: agoraMs, ttl: m.ttl_ms,
      estado: nome, nivel, acao, indice: valido ? estimativa.indice : null, confianca: valido ? estimativa.confianca : 0});
  }
  if (novo.ultimo_estado !== nome || novo.ultima_acao_ms === null || agoraMs - novo.ultima_acao_ms >= m.renovar_acao_ms) {
    adicionar('acao'); novo.ultima_acao_ms = agoraMs; novo.ultimo_estado = nome;
  }
  if (novo.ultimo_heartbeat_ms === null || agoraMs - novo.ultimo_heartbeat_ms >= m.heartbeat_ms) {
    adicionar('heartbeat'); novo.ultimo_heartbeat_ms = agoraMs;
  }
  return [novo, mensagens];
}
