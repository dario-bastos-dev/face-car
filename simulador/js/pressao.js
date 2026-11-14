/* VIGIA · Parte 3 — pressão das mãos no volante (sensor FSR402 + Arduino).
 *
 * Mesmas regras da Parte 1 (entrada/pressao.py), com os valores de config/analise.json:
 *   - o Arduino manda analogRead(A0), de 0 a 1023, um número por linha, a 115200 baud;
 *   - abaixo de sensor.limiar_sonolencia (400) a mão está frouxa; só conta se ficar baixa por
 *     ALERTA_SIMULADOR_MS (5 s) seguidos: soltar para trocar a marcha não conta. A Parte 1 usa
 *     sensor.pressao_baixa_alerta_ms (15 s); o simulador avisa antes, para a demonstração;
 *   - aí sai o aviso (faixa na tela, som, voz e registro) e o índice de sonolência do CNN ganha
 *     fusao.bonus_volante_frouxo (0,3 → 30 pontos) enquanto continuar frouxa;
 *   - o nível sobe para ATENÇÃO ("segure firme no volante"): com o scanner ligado, pela política
 *     (ia.js garante índice ≥ 40); sem ele, o próprio sensor muda o nível e o devolve ao normal
 *     quando a mão aperta de novo.
 *
 * Fontes:
 *   - Arduino real pelo navegador (Web Serial, Chrome/Edge): botão "Conectar Arduino". Como no
 *     Python, o que estava no buffer e a primeira linha (que pode vir pela metade) são descartados.
 *   - Simulação temporária (sem o sensor): botões Firme / Leve / Frouxa / Solta e o controle
 *     deslizante geram leituras ~50 por segundo, com um pouco de ruído, como o sensor.
 * Sem leituras há mais de 1 s (sensor mudo), a contagem recomeça.
 */
(() => {
'use strict';
const V = window.VIGIA, { state, clamp } = V;
const $ = id => document.getElementById(id);

// Tempo de mão frouxa até o aviso, só no simulador (a Parte 1 segue com o valor do config, 15 s).
const ALERTA_SIMULADOR_MS = 5000;
const CFG = { limiar: 400, alertaMs: ALERTA_SIMULADOR_MS, baud: 115200, bonus: .3 }; // limiar, baud e bônus vêm de config/analise.json
fetch('../config/analise.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(c => {
  if (!c) return;
  CFG.limiar = c.sensor?.limiar_sonolencia ?? CFG.limiar;
  CFG.baud = c.sensor?.baud ?? CFG.baud;
  CFG.bonus = c.fusao?.bonus_volante_frouxo ?? CFG.bonus;
  painel(true);
}).catch(() => {});

const SIMULADO = { firme: 820, leve: 520, frouxa: 180, solta: 0 };
const MUDO_MS = 1000;
const P = { fonte: 'nenhum', valor: null, recebidoEm: 0, baixaDesde: null, frouxo: false, alvoSim: null, porta: null };

/* ---------- leituras e regra do volante frouxo ---------- */
function leitura(valor, agora = performance.now()) {
  P.valor = clamp(Math.round(valor), 0, 1023); P.recebidoEm = agora;
  if (P.valor < CFG.limiar) {
    if (P.baixaDesde == null) P.baixaDesde = agora;
  } else if (P.baixaDesde != null) {
    if (P.frouxo) {
      V.log(`Volante apertado de novo após ${((agora - P.baixaDesde) / 1000).toFixed(1).replace('.', ',')} s`, 'driver_response');
      V.emit('volanteFirme');
      // sem o scanner, foi o sensor que levou a ATENÇÃO: volta ao normal
      if (!V.ia?.ativo && state.level === 'attention' && state.source === 'volante') V.setLevel('normal', 'volante');
    }
    P.baixaDesde = null; P.frouxo = false;
  }
}
function verificar(agora) {
  if (P.fonte !== 'nenhum' && P.valor != null && agora - P.recebidoEm > MUDO_MS) { // sensor mudo
    P.baixaDesde = null; P.frouxo = false; P.valor = null;
  }
  const ms = baixaMs(agora);
  if (!P.frouxo && ms != null && ms >= CFG.alertaMs) {
    P.frouxo = true;
    V.log(`Pressão no volante abaixo de ${CFG.limiar} há mais de ${CFG.alertaMs / 1000} s: mãos frouxas (possível sonolência)`, 'alert');
    V.emit('volanteFrouxo');
    // sem o scanner, o sensor leva o nível a ATENÇÃO (com ele, a política faz isso pelo índice)
    if (!V.ia?.ativo && (state.level === 'normal' || state.degraded)) V.setLevel('attention', 'volante');
  }
}
const baixaMs = (agora = performance.now()) => P.baixaDesde == null ? null : agora - P.baixaDesde;

/* ---------- simulação temporária (sem o sensor) ---------- */
let simAcum = 0;
function simular(dt) {
  if (P.fonte !== 'simulado' || P.alvoSim == null) return;
  simAcum += dt;
  while (simAcum >= .02) { // ~50 leituras por segundo, como o Arduino
    simAcum -= .02;
    const ruido = P.alvoSim > 0 ? (Math.random() - .5) * 24 : 0;
    leitura(P.alvoSim + ruido);
  }
}
function setSimulado(nome, valor) {
  if (P.porta) desconectar();
  P.fonte = 'simulado'; P.alvoSim = valor ?? SIMULADO[nome];
  const s = $('pressaoSlider'); if (s) s.value = P.alvoSim;
  if (nome) V.log(`Sensor de pressão (simulado): ${nome} (${P.alvoSim})`, 'system');
  painel(true);
}
function pararSimulacao() {
  P.fonte = 'nenhum'; P.alvoSim = null; P.valor = null; P.baixaDesde = null; P.frouxo = false;
  V.log('Sensor de pressão: simulação desligada', 'system'); painel(true);
}

/* ---------- Arduino pela Web Serial ---------- */
async function conectar() {
  if (!('serial' in navigator)) { V.log('Este navegador não tem Web Serial: use o Chrome ou o Edge no computador', 'error'); return; }
  let porta;
  try { porta = await navigator.serial.requestPort(); } catch { return; } // usuário cancelou
  try { await porta.open({ baudRate: CFG.baud }); }
  catch (e) { V.log('Não foi possível abrir a porta do sensor: ' + e.message, 'error'); return; }
  P.porta = porta; P.fonte = 'serial'; P.alvoSim = null; P.valor = null; P.baixaDesde = null; P.frouxo = false;
  V.log(`Sensor de pressão conectado pela serial (${CFG.baud} baud)`, 'system'); painel(true);
  lerSerial(porta);
}
async function lerSerial(porta) {
  const decodificador = new TextDecoderStream(), fechado = porta.readable.pipeTo(decodificador.writable).catch(() => {});
  const leitor = decodificador.readable.getReader();
  P.leitor = leitor;
  let resto = '', primeira = true;
  const abertoEm = performance.now();
  try {
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      if (performance.now() - abertoEm < 150) continue; // o que estava no buffer é antigo
      resto += value;
      if (resto.length > 256) resto = resto.slice(-64);   // lixo sem quebra de linha (baud errado)
      const linhas = resto.split(/\r?\n/); resto = linhas.pop();
      for (const l of linhas) {
        if (primeira) { primeira = false; continue; }      // pode ter vindo pela metade
        const m = l.match(/\d+/); if (m) leitura(Number(m[0]));
      }
    }
  } catch { /* cabo desconectado */ }
  try { leitor.releaseLock(); } catch { /* já liberado */ }
  await fechado;
  try { await porta.close(); } catch { /* já fechada */ }
  if (P.porta === porta) {
    P.porta = null; P.fonte = 'nenhum'; P.valor = null; P.baixaDesde = null; P.frouxo = false;
    V.log('Sensor de pressão desconectado', 'system'); painel(true);
  }
}
async function desconectar() {
  const leitor = P.leitor; P.leitor = null;
  try { await leitor?.cancel(); } catch { /* ok */ }
}

/* ---------- painel, faixa de aviso e leitura para o índice ---------- */
let pintadoEm = 0;
function painel(forcar = false) {
  const el = $('pressaoPanel'); if (!el) return;
  const agora = performance.now();
  if (!forcar && agora - pintadoEm < 120) return;
  pintadoEm = agora;
  const v = P.valor, ms = baixaMs(agora);
  el.dataset.estado = P.fonte === 'nenhum' ? 'nenhum' : P.frouxo ? 'frouxo' : v != null && v < CFG.limiar ? 'baixa' : 'firme';
  $('pressaoBar').style.width = (v == null ? 0 : v / 1023 * 100) + '%';
  $('pressaoLimiar').style.left = (CFG.limiar / 1023 * 100) + '%';
  $('pressaoValor').textContent = v == null ? '—' : v;
  const fonte = { nenhum: 'sem sensor', simulado: 'SIMULADO', serial: 'ARDUINO' }[P.fonte];
  let txt;
  if (P.fonte === 'nenhum') txt = 'use os botões ou conecte o Arduino';
  else if (v == null) txt = 'aguardando leituras';
  else if (P.frouxo) txt = `FROUXA há ${Math.floor(ms / 1000)} s · ATENÇÃO · +${Math.round(CFG.bonus * 100)} no índice`;
  else if (ms != null) txt = `baixa há ${Math.floor(ms / 1000)} s (aviso em ${CFG.alertaMs / 1000} s)`;
  else txt = 'mãos firmes';
  $('pressaoStatus').textContent = `${fonte} · ${txt}`;
  for (const b of document.querySelectorAll('[data-pressao]')) b.classList.toggle('selected', P.fonte === 'simulado' && P.alvoSim === SIMULADO[b.dataset.pressao]);
  $('pressaoConectar').textContent = P.porta ? 'Desconectar Arduino' : 'Conectar Arduino';
  const aviso = $('avisoVolante'); if (aviso) aviso.hidden = !P.frouxo;
}

V.on('ready', () => {
  for (const b of document.querySelectorAll('[data-pressao]')) b.onclick = () => setSimulado(b.dataset.pressao);
  $('pressaoSlider').oninput = e => setSimulado(null, Number(e.target.value));
  $('pressaoParar').onclick = pararSimulacao;
  $('pressaoConectar').onclick = () => P.porta ? desconectar() : conectar();
  painel(true);
});
// o sensor simulado continua mandando leituras com a simulação pausada, como o Arduino real
V.addRenderer(dt => { simular(dt); verificar(performance.now()); painel(); }, 'pressao');

V.pressao = {
  get valor() { return P.valor; }, get fonte() { return P.fonte; }, get frouxo() { return P.frouxo; },
  baixaMs, limiar: () => CFG.limiar,
  // pontos somados ao índice de sonolência (0..100) com o volante frouxo há muito tempo
  bonusIndice: () => P.frouxo ? Math.round(CFG.bonus * 100) : 0,
  simular: setSimulado, leitura,
  atualizar: () => { verificar(performance.now()); painel(true); }, // testes: sem depender da animação
};
})();
