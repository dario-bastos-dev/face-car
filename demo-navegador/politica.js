/** Máquina de estados pura. Ticks usam o relógio monotônico da sessão. */
export const ESTADOS = ['NORMAL', 'ATENCAO', 'ALERTA', 'INTERVENCAO', 'DEGRADADO'];
export function validarTempo(valor, nome = 'agora_ms') {
  if (!Number.isSafeInteger(valor) || valor < 0) throw new Error(`${nome} deve ser inteiro não negativo seguro`);
}
export function validarPolitica(config) {
  const p = config.politica;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Configuração politica ausente');
  if (typeof p.confianca_minima !== 'number' || !Number.isFinite(p.confianca_minima)
      || !(p.confianca_minima > 0 && p.confianca_minima <= 1)) throw new Error('confianca_minima deve estar em (0, 1]');
  for (const chave of ['validade_estimativa_ms', 'intervalo_maximo_ms', 'prazo_resposta_ms']) {
    validarTempo(p[chave], chave);
    if (chave !== 'validade_estimativa_ms' && p[chave] === 0) throw new Error(`${chave} deve ser positivo`);
  }
  const linhas = p.transicoes;
  if (!Array.isArray(linhas) || !linhas.length) throw new Error('Tabela de transições vazia');
  const primeira = linhas[0];
  if (!primeira || typeof primeira !== 'object' || Object.entries({de: '*', para: 'DEGRADADO', condicao: 'sem_confianca', duracao_ms: 0})
    .some(([k, v]) => primeira[k] !== v)) throw new Error('Primeira transição deve degradar imediatamente sem confiança');
  for (const [n, linha] of linhas.entries()) {
    if (!linha || typeof linha !== 'object' || Array.isArray(linha)) throw new Error('Transição deve ser objeto');
    validarTempo(linha.duracao_ms, 'duracao_ms');
    if (n === 0) continue;
    if (!ESTADOS.includes(linha.de) || !ESTADOS.includes(linha.para) || linha.de === linha.para) throw new Error('Estados da transição inválidos');
    const condicao = linha.condicao;
    if (!['alto', 'baixo', 'recuperado', 'sem_resposta'].includes(condicao)) throw new Error('Condição da transição inválida');
    if (condicao === 'recuperado' && linha.de !== 'DEGRADADO') throw new Error('recuperado só pode sair de DEGRADADO');
    if ((condicao === 'sem_resposta' && (linha.de !== 'ALERTA' || linha.para !== 'INTERVENCAO'))
        || (linha.para === 'INTERVENCAO' && condicao !== 'sem_resposta')) throw new Error('INTERVENCAO exige ALERTA, evidência e prazo sem resposta');
    if (typeof linha.limiar !== 'number' || !Number.isFinite(linha.limiar) || linha.limiar < 0 || linha.limiar > 100) throw new Error('limiar deve estar em [0, 100]');
  }
  return config;
}
export function estadoInicial() {
  return {nome: 'DEGRADADO', inicio_ms: null, ultimo_ms: null, pendente: null,
    pendente_desde_ms: null, prazo_resposta_em_ms: null};
}
export function evidenciaValida(estimativa, agoraMs, config) {
  const p = config.politica;
  const {indice, confianca, t_ms: instante} = estimativa;
  return typeof indice === 'number' && Number.isFinite(indice) && indice >= 0 && indice <= 100
    && typeof confianca === 'number' && Number.isFinite(confianca)
    && confianca >= p.confianca_minima && confianca <= 1
    && Number.isSafeInteger(instante) && instante >= 0 && instante <= agoraMs
    && agoraMs - instante <= p.validade_estimativa_ms;
}
export function transicionar(estado, estimativa, agoraMs, config, respostaMotorista = false) {
  validarPolitica(config);
  validarTempo(agoraMs);
  validarTempo(agoraMs + config.politica.prazo_resposta_ms, 'prazo absoluto');
  if (!ESTADOS.includes(estado.nome)) throw new Error('Estado desconhecido');
  if (typeof respostaMotorista !== 'boolean') throw new Error('resposta_motorista deve ser booleano');
  const novo = {...estado}, anteriorMs = novo.ultimo_ms, p = config.politica;
  if (anteriorMs !== null && agoraMs < anteriorMs) throw new Error('Tempo da política fora de ordem');
  if (novo.inicio_ms === null) novo.inicio_ms = agoraMs;
  if (anteriorMs !== null && agoraMs - anteriorMs > p.intervalo_maximo_ms) {
    novo.pendente = novo.pendente_desde_ms = null;
    if (novo.nome === 'ALERTA') novo.prazo_resposta_em_ms = agoraMs + p.prazo_resposta_ms;
  }
  novo.ultimo_ms = agoraMs;
  const valido = evidenciaValida(estimativa, agoraMs, config);
  if (respostaMotorista && valido && novo.nome === 'ALERTA') novo.prazo_resposta_em_ms = agoraMs + p.prazo_resposta_ms;
  let selecionada = null;
  for (const [numero, linha] of p.transicoes.entries()) {
    if (!['*', novo.nome].includes(linha.de) || linha.para === novo.nome) continue;
    let satisfeita;
    if (linha.condicao === 'sem_confianca') satisfeita = !valido;
    else if (!valido) satisfeita = false;
    else if (['alto', 'sem_resposta'].includes(linha.condicao)) satisfeita = estimativa.indice >= linha.limiar;
    else if (linha.condicao === 'baixo') satisfeita = estimativa.indice <= linha.limiar;
    else if (linha.condicao === 'recuperado') satisfeita = estimativa.indice < linha.limiar;
    else throw new Error(`Condição desconhecida: ${linha.condicao}`);
    if (satisfeita) { selecionada = [numero, linha]; break; }
  }
  if (selecionada === null) { novo.pendente = novo.pendente_desde_ms = null; return novo; }
  const [numero, linha] = selecionada;
  if (novo.pendente !== numero) { novo.pendente = numero; novo.pendente_desde_ms = agoraMs; }
  const prazoCumprido = linha.condicao !== 'sem_resposta'
    || (novo.prazo_resposta_em_ms !== null && agoraMs >= novo.prazo_resposta_em_ms);
  if (agoraMs - novo.pendente_desde_ms >= linha.duracao_ms && prazoCumprido) {
    Object.assign(novo, {nome: linha.para, inicio_ms: agoraMs, pendente: null,
      pendente_desde_ms: null, prazo_resposta_em_ms: linha.para === 'ALERTA' ? agoraMs + p.prazo_resposta_ms : null});
  }
  return novo;
}
