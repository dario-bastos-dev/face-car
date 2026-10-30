// Estimador puro, espelho de estimador/nucleo.py. Sem DOM, relógio ou câmera.
// As amostras sustentam intervalos [t_i, min(t_seguinte, t_i + max_intervalo)].

const numero = (x) => typeof x === "number" && Number.isFinite(x);
const limitar = (x, a, b) => Math.max(a, Math.min(b, x));

function exigirNumero(x, nome, minimo, maximo, exclusivo = false) {
  if (!numero(x) || (exclusivo ? x <= minimo : x < minimo) || x > maximo) {
    throw new Error(`Configuração inválida: ${nome}`);
  }
}

export function validarConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Configuração deve ser um objeto");
  }
  exigirNumero(config.janela_s, "janela_s", 0, 86400, true);
  const janela = config.janela_s * 1000;
  for (const nome of ["max_intervalo_ms", "min_evidencia_ms", "saturacao_fechamento_ms"]) {
    exigirNumero(config[nome], nome, 0, janela, true);
  }
  exigirNumero(config.min_fechamento_ms, "min_fechamento_ms", 0, janela);
  exigirNumero(config.max_atraso_ms, "max_atraso_ms", 0, 86400000);
  exigirNumero(config.confianca_rastreio_minima, "confianca_rastreio_minima", 0, 1);
  const olhos = config.olhos;
  if (!olhos || typeof olhos !== "object" || Array.isArray(olhos)) {
    throw new Error("Configuração inválida: olhos");
  }
  exigirNumero(olhos.fechamento_limiar, "olhos.fechamento_limiar", 0, 1, true);
  for (const lado of ["esq", "dir"]) {
    exigirNumero(olhos[`ear_fechado_${lado}`], `olhos.ear_fechado_${lado}`, 0, 1);
    exigirNumero(olhos[`ear_aberto_${lado}`], `olhos.ear_aberto_${lado}`,
      olhos[`ear_fechado_${lado}`], 1, true);
  }
  return config;
}

function timestamp(valor, nome) {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new Error(`${nome} deve ser inteiro não negativo e seguro`);
  }
}

function observacao(metrica, config) {
  const valida = (metrica.rosto_visivel === true || metrica.rosto_visivel === 1)
    && numero(metrica.confianca)
    && metrica.confianca >= config.confianca_rastreio_minima && metrica.confianca <= 1
    && numero(metrica.atraso_ms) && metrica.atraso_ms >= 0
    && metrica.atraso_ms <= config.max_atraso_ms
    && [metrica.ear_esq, metrica.ear_dir].every((x) => numero(x) && x >= 0 && x <= 1);
  if (!valida) return { valida: false, fechada: false };
  const olhos = config.olhos;
  const fechada = ["esq", "dir"].every((lado) => {
    const fracao = limitar((olhos[`ear_aberto_${lado}`] - metrica[`ear_${lado}`])
      / (olhos[`ear_aberto_${lado}`] - olhos[`ear_fechado_${lado}`]), 0, 1);
    return fracao + 1e-12 >= olhos.fechamento_limiar;
  });
  return { valida, fechada };
}

/**
 * Estima índice de 0 a 100 e confiança de 0 a 1 sem alterar as entradas.
 * null significa ausência de tempo válido; confiança zero impede usar histórico
 * quando a observação atual é inválida ou antiga. EAR é proxy da abertura, não
 * medida direta da área da pupila. Os limiares são um baseline a validar.
 */
export function estimar(metricas, config, agoraMs = null) {
  validarConfig(config);
  if (!Array.isArray(metricas)) throw new Error("Métricas devem ser uma lista");
  let anterior = -1;
  for (const metrica of metricas) {
    if (!metrica || typeof metrica !== "object" || Array.isArray(metrica)) {
      throw new Error("Métrica deve ser um objeto");
    }
    timestamp(metrica.t_ms, "t_ms");
    if (metrica.t_ms <= anterior) throw new Error("t_ms deve ser estritamente crescente");
    anterior = metrica.t_ms;
  }
  const agora = agoraMs ?? (metricas.at(-1)?.t_ms ?? 0);
  timestamp(agora, "agora_ms");
  if (anterior > agora) throw new Error("Métricas não podem estar no futuro");
  const inicio = Math.max(metricas[0]?.t_ms ?? agora, agora - config.janela_s * 1000);
  const duracao = agora - inicio;
  const observacoes = metricas.map((m) => observacao(m, config));
  let tempoValido = 0, tempoFechado = 0, somaConfianca = 0, amostrasValidas = 0;
  let inicioEpisodio = null, fimEpisodio = null;
  const concluirEpisodio = () => {
    if (inicioEpisodio !== null && fimEpisodio - inicioEpisodio >= config.min_fechamento_ms) {
      tempoFechado += Math.max(0, Math.min(agora, fimEpisodio) - Math.max(inicio, inicioEpisodio));
    }
    inicioEpisodio = null;
    fimEpisodio = null;
  };
  for (let i = 0; i < metricas.length; i++) {
    const m = metricas[i], obs = observacoes[i];
    const fim = Math.min(metricas[i + 1]?.t_ms ?? agora, m.t_ms + config.max_intervalo_ms, agora);
    const dt = Math.max(0, fim - Math.max(m.t_ms, inicio));
    if (obs.valida && dt > 0) {
      tempoValido += dt;
      somaConfianca += m.confianca * dt;
      amostrasValidas++;
    }
    if (!obs.valida || !obs.fechada) {
      concluirEpisodio();
    } else {
      if (inicioEpisodio !== null && m.t_ms !== fimEpisodio) concluirEpisodio();
      if (inicioEpisodio === null) inicioEpisodio = m.t_ms;
      fimEpisodio = fim;
    }
  }
  const ultima = metricas.at(-1), obsUltima = observacoes.at(-1);
  const atualValida = Boolean(ultima && obsUltima.valida && agora - ultima.t_ms <= config.max_intervalo_ms);
  const continuo = atualValida && obsUltima.fechada && inicioEpisodio !== null
    ? Math.max(0, agora - Math.max(inicioEpisodio, inicio)) : 0;
  concluirEpisodio();
  const cobertura = duracao > 0 ? limitar(tempoValido / duracao, 0, 1) : 0;
  const perclos = tempoValido > 0 ? limitar(tempoFechado / tempoValido, 0, 1) : null;
  const confianca = atualValida && tempoValido > 0
    ? limitar(cobertura * (somaConfianca / tempoValido)
      * Math.min(1, tempoValido / config.min_evidencia_ms), 0, 1) : 0;
  const indice = perclos === null ? null
    : 100 * Math.max(perclos, Math.min(1, continuo / config.saturacao_fechamento_ms));
  return {
    t_ms: agora, indice, confianca, perclos,
    fechamento_continuo_ms: continuo,
    tempo_valido_ms: tempoValido,
    tempo_fechado_ms: tempoFechado,
    cobertura, amostras_validas: amostrasValidas,
  };
}
