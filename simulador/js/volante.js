/* VIGIA · Parte 3 — modo de condução "Volante": o motorista dirige pelo controlador de jogo.
 *
 * Mapeamento (controlador genérico de 4 eixos e 12 botões, como o Windows o mostra em "Testar"):
 *   Eixo X ........ volante: gira o volante da cabine 3D e desloca o veículo na pista de mão
 *                   única (esquerda até a faixa de ultrapassagem, direita até o acostamento).
 *                   Liga a seta do lado.
 *   Eixo Y ........ para cima acelera, para baixo freia. Solto, o veículo perde velocidade aos
 *                   poucos. Nunca dá ré: a velocidade para em zero.
 *   Chapéu (POV) .. as setas no centro do volante, em qualquer direção (inclusive diagonais): buzina,
 *                   um som contínuo enquanto estiver apertado.
 *   Botão 5 ....... alterna a visão entre 2D e cabine 3D (nos dois modos de condução). O Windows
 *                   numera os botões a partir de 1; na Gamepad API ele é o índice 4.
 * Sem controlador, as setas do teclado fazem o mesmo (↑ acelera, ↓ freia, ← → volante, B buzina).
 *
 * Na intervenção o VIGIA assume: reduz e leva o veículo ao acostamento, ignorando o controlador.
 * Numa batida os comandos também travam: os dois veículos param e, 2 s depois, o motorista retoma.
 *
 * No Chrome/Edge para Windows, um controlador genérico (DirectInput) chega pela Gamepad API com
 * mapping "" e o chapéu num eixo próprio (em geral o 9): -1 para cima, girando no sentido horário
 * em passos de 2/7, e ~1,29 solto. Em controladores com mapping "standard", o direcional são os
 * botões 12 a 15. O navegador só mostra o controlador depois que algum botão dele é apertado.
 */
(() => {
const V = window.VIGIA, { state, clamp } = V;
const $ = id => document.getElementById(id);

const MAPA = { direcao: 0, pedal: 1, visao: 4 };  // eixos X e Y; botão 5 (índice 4) troca a visão
const ZONA_MORTA = .08;
const CHAVE = 'vigia.controle';

const C = V.controle = {
  conectado: false, nome: '', direcao: 0, pedal: 0, buzina: false, eixoChapeu: null, fonte: 'nenhum',
  invertePedal: false,
};
const teclas = new Set();

const zona = v => Math.abs(v) < ZONA_MORTA ? 0 : Math.sign(v) * (Math.abs(v) - ZONA_MORTA) / (1 - ZONA_MORTA);
function controlador() {
  for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected && p.axes.length >= 2) return p;
  return null;
}
// Eixo do chapéu: o 9 quando existe; senão, o primeiro eixo (a partir do 2) que repousa fora de [-1, 1].
function eixoDoChapeu(p) {
  if (p.mapping === 'standard') return null;
  if (C.eixoChapeu != null && C.eixoChapeu < p.axes.length) return C.eixoChapeu;
  if (p.axes.length > 9) return (C.eixoChapeu = 9);
  for (let i = 2; i < p.axes.length; i++) if (Math.abs(p.axes[i]) > 1.05) return (C.eixoChapeu = i);
  return null;
}
function chapeuApertado(p) {
  if (p.mapping === 'standard') return [12, 13, 14, 15].some(i => p.buttons[i]?.pressed);
  const i = eixoDoChapeu(p);
  return i != null && Math.abs(p.axes[i]) <= 1.01;
}

function ler(dt) {
  const p = controlador();
  if (p) {
    if (!C.conectado || C.nome !== p.id) { C.conectado = true; C.nome = p.id; C.eixoChapeu = null; V.log('Controlador conectado: ' + p.id, 'system'); syncUi(); }
    C.fonte = 'controlador';
    C.direcao = clamp(zona(p.axes[MAPA.direcao] ?? 0), -1, 1);
    const y = zona(p.axes[MAPA.pedal] ?? 0);
    C.pedal = clamp(C.invertePedal ? y : -y, -1, 1); // eixo Y para cima (negativo) acelera
    C.buzina = chapeuApertado(p);
    // botão 5: troca a visão ao apertar (não repete enquanto segura)
    const visao = !!p.buttons[MAPA.visao]?.pressed;
    if (visao && !C.botaoVisao) V.setViewMode(state.viewMode === '2d' ? '3d' : '2d');
    C.botaoVisao = visao;
  } else {
    if (C.conectado) { C.conectado = false; V.log('Controlador desconectado', 'system'); syncUi(); }
    C.fonte = teclas.size ? 'teclado' : 'nenhum';
    // teclado: o volante volta ao centro sozinho, como um volante com mola
    const alvo = (teclas.has('arrowright') ? 1 : 0) - (teclas.has('arrowleft') ? 1 : 0);
    C.direcao += clamp(alvo - C.direcao, -5 * dt, 5 * dt);
    if (!alvo && Math.abs(C.direcao) < .02) C.direcao = 0;
    C.pedal = (teclas.has('arrowup') ? 1 : 0) - (teclas.has('arrowdown') ? 1 : 0);
    C.buzina = teclas.has('b');
  }
  // Intervenção: o VIGIA assume e trava os comandos (volante, pedais e buzina) até ela terminar;
  // core.js ignora o controlador e leva o veículo ao acostamento.
  const intervencao = state.controle === 'volante' && !state.degraded && state.level === 'intervention';
  const batida = !!V.world.colisao && V.world.colisao.fase !== 'carencia';
  const travado = intervencao || (state.controle === 'volante' && batida);
  if (travado !== C.travado) {
    C.travado = travado;
    if (state.controle === 'volante' && !batida) V.log(travado ? 'Intervenção: comandos do volante travados; o VIGIA leva o veículo ao acostamento' : 'Comandos do volante liberados', 'intervention');
  }
  // buzina: um som contínuo enquanto o chapéu estiver apertado
  const buzina = state.controle === 'volante' && !travado && C.buzina;
  if (buzina !== C.buzinando) { C.buzinando = buzina; V.emit(buzina ? 'buzinaInicio' : 'buzinaFim'); }
  if (painelAberto()) painel();
}

/* ---------- modo de condução ---------- */
function setControle(modo) {
  if (modo === state.controle) return;
  state.controle = modo;
  try { localStorage.setItem(CHAVE, modo); } catch { /* sem armazenamento: só nesta sessão */ }
  if (modo === 'padrao') { state.target = VIGIA.VEHICLES[state.vehicle].cruise; state.freando = false; }
  V.log(modo === 'volante'
    ? 'Simulação: Volante (' + (C.conectado ? C.nome : 'sem controlador; aperte um botão dele ou use as setas do teclado') + ')'
    : 'Simulação: Padrão (o simulador dirige)', 'system');
  syncUi();
}
function syncUi() {
  for (const [id, modo] of [['ctrlPadraoBtn', 'padrao'], ['ctrlVolanteBtn', 'volante']]) {
    const b = $(id); if (!b) continue;
    b.classList.toggle('selected', state.controle === modo); b.setAttribute('aria-pressed', state.controle === modo);
  }
  const vb = $('ctrlVolanteBtn');
  if (vb) { vb.classList.toggle('pad-on', C.conectado); vb.title = C.conectado ? 'Controlador: ' + C.nome : 'Nenhum controlador detectado (aperte um botão dele); setas do teclado funcionam'; }
  painel();
}
const painelAberto = () => $('settingsModal')?.classList.contains('open');
function painel() {
  const el = $('padStatus'); if (!el) return;
  const pct = v => (v > 0 ? '+' : '') + Math.round(v * 100) + '%';
  el.textContent = C.conectado
    ? `${C.nome}\nVolante (eixo X): ${pct(C.direcao)} · Pedal (eixo Y): ${pct(C.pedal)} · Buzina (chapéu${C.eixoChapeu != null ? ', eixo ' + C.eixoChapeu : ''}): ${C.buzina ? 'apertada' : 'solta'} · Visão 2D/3D (botão 5): ${C.botaoVisao ? 'apertado' : 'solto'}`
    : 'Nenhum controlador detectado. Conecte e aperte qualquer botão dele com a página aberta.\nSem controlador: ↑ acelera, ↓ freia, ← → volante, B buzina.';
}

V.on('ready', () => {
  $('ctrlPadraoBtn').onclick = () => setControle('padrao');
  $('ctrlVolanteBtn').onclick = () => setControle('volante');
  $('invertePedal').onchange = e => { C.invertePedal = e.target.checked; };
  addEventListener('gamepadconnected', () => ler(0));
  addEventListener('gamepaddisconnected', () => ler(0));
  // setas do teclado só valem no modo volante (no padrão não fazem nada)
  addEventListener('keydown', e => {
    if (state.controle !== 'volante' || e.target.closest?.('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'b'].includes(k)) { teclas.add(k); if (k.startsWith('arrow')) e.preventDefault(); }
  });
  addEventListener('keyup', e => teclas.delete(e.key.toLowerCase()));
  addEventListener('blur', () => teclas.clear());
  let salvo = null; try { salvo = localStorage.getItem(CHAVE); } catch { /* idem */ }
  if (salvo === 'volante') setControle('volante'); else syncUi();
});
V.addInput(ler);
V.setControle = setControle;
})();
