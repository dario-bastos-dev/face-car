/* VIGIA v0.6 — áudio do simulador (Web Audio, sintetizado no navegador).
 * Motor ligado à rotação e à carga (acelerador), trocas de marcha, rolagem de pneus, vento,
 * passagens com Doppler, batidas, ambiente diurno/noturno, pisca-alerta, buzina e alertas com voz. */
(() => {
'use strict';
const V = window.VIGIA;
const { state, world, env, clamp } = V;

const A = V.audio = { enabled: false };
let ctx, master, bus = {}, engine, road, wind, ambience, noiseBuf, pneu;

/* Buzinas gravadas (assets/sons). Trechos em segundos, medidos pelo envelope de cada arquivo:
 *  classica   buzina comum de carro (~1,7 kHz): toque curto 0,05-0,22, médio 0,7-1,2, longo 1,8-2,9
 *  dois       "bi-bi" (~420 Hz): dois toques em 0,9 s
 *  grave      buzina grave de caminhão: toques em 0,05-0,25 e 0,9-1,15
 *  forte      toque forte 0,05-0,7 e longo 1,3-3,0 (alarme da intervenção, toques seguidos) */
const SONS = { classica: 'buzina_classica', dois: 'buzina_dois_toques', grave: 'buzina_grave', forte: 'buzina_forte' };
const buffers = {};
function carregarSons() {
  for (const [nome, arq] of Object.entries(SONS)) {
    if (buffers[nome]) continue;
    fetch(`assets/sons/${arq}.mp3`).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))
      .then(buf => { buffers[nome] = buf; }).catch(() => {}); // sem o arquivo, cai no som sintetizado
  }
}
// Toca um trecho gravado; devolve os nós para ajustar volume, panorâmica e tom enquanto toca.
function sample(nome, { inicio = 0, dur, vol = 1, pan = 0, rate = 1, delay = 0, dest = bus.alert } = {}) {
  const buf = buffers[nome];
  if (!A.enabled || !buf) return null;
  const t = ctx.currentTime + delay, src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf; src.playbackRate.value = rate;
  const d = Math.min(dur ?? buf.duration - inicio, buf.duration - inicio);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .015);
  g.gain.setValueAtTime(vol, t + Math.max(.02, d / rate - .04)); g.gain.linearRampToValueAtTime(0, t + d / rate);
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (p) p.pan.value = pan;
  src.connect(g); (p ? g.connect(p) : g).connect(dest);
  src.start(t, inicio, d); src.stop(t + d / rate + .05);
  return { src, g, p, fim: t + d / rate };
}

function makeNoise() {
  const len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + .02 * w) / 1.02; d[i] = w * .5 + last * 3; } // mistura branco/marrom
  return b;
}
function loopNoise() { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s; }
function gainNode(v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }
function filter(type, freq, q = .7) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; }
function ramp(param, v, t = .15) { param.setTargetAtTime(v, ctx.currentTime, t); }

function buildGraph() {
  master = gainNode(state.volume);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  bus.drive = gainNode(1); bus.drive.connect(master);   // sons de condução
  bus.alert = gainNode(1); bus.alert.connect(master);   // alertas (nunca abafados)
  noiseBuf = makeNoise();

  // motor: harmônicos + ronco filtrado
  engine = { out: gainNode(0), lp: filter('lowpass', 600, 1.2), oscs: [] };
  [[1, 'sawtooth', .5], [2, 'square', .18], [.5, 'sine', .55], [3, 'sawtooth', .08]].forEach(([mul, type, vol]) => {
    const o = ctx.createOscillator(), g = gainNode(vol); o.type = type; o.connect(g).connect(engine.lp); o.start(); engine.oscs.push({ o, mul });
  });
  const rumble = loopNoise(), rf = filter('bandpass', 120, 1.5); engine.rumbleGain = gainNode(.25);
  rumble.connect(rf).connect(engine.rumbleGain).connect(engine.lp);
  // engine.troca: o motor "respira" na troca de marcha (corte rápido e volta)
  engine.troca = gainNode(1);
  engine.corte = gainNode(1); // limitador de giro: corta e volta rapidamente
  engine.lp.connect(engine.troca).connect(engine.corte).connect(engine.out).connect(bus.drive);
  // aceleração: ronco de admissão (ruído na faixa do giro) e assobio do turbo, só com o pé no acelerador
  engine.adm = { src: loopNoise(), bp: filter('bandpass', 400, 2.2), g: gainNode(0) };
  engine.adm.src.connect(engine.adm.bp).connect(engine.adm.g).connect(engine.troca);
  engine.turbo = { o: ctx.createOscillator(), g: gainNode(0) };
  engine.turbo.o.type = 'sine'; engine.turbo.o.connect(engine.turbo.g).connect(engine.troca); engine.turbo.o.start();
  // caminhão (diesel): a batida característica, um ruído médio pulsando no ritmo das explosões
  engine.diesel = { src: loopNoise(), bp: filter('bandpass', 1100, 1.4), amp: gainNode(0), mod: ctx.createOscillator(), modG: gainNode(0), g: gainNode(0) };
  engine.diesel.mod.type = 'square'; engine.diesel.mod.connect(engine.diesel.modG).connect(engine.diesel.amp.gain); engine.diesel.mod.start();
  engine.diesel.src.connect(engine.diesel.bp).connect(engine.diesel.amp).connect(engine.diesel.g).connect(engine.troca);

  // rolagem dos pneus no asfalto
  road = { src: loopNoise(), lp: filter('lowpass', 500), g: gainNode(0) };
  road.src.connect(road.lp).connect(road.g).connect(bus.drive);
  // pneus cantando (frenagem brusca): duas camadas da mesma amostra procedural (veja
  // guinchoPneu), defasadas e em tons um pouco diferentes, como dois pneus arrastando juntos
  const buf = guinchoPneu();
  pneu = { g: gainNode(0), hp: filter('highpass', 700, .7), pico: ctx.createBiquadFilter(), camadas: [] };
  pneu.pico.type = 'peaking'; pneu.pico.frequency.value = 2400; pneu.pico.Q.value = 1.2; pneu.pico.gain.value = 5;
  [[1, .6, 0, -.25], [1.19, .45, 1.37, .25]].forEach(([tom, vol, ini, pan]) => {
    const src = ctx.createBufferSource(), g = gainNode(vol), pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.buffer = buf; src.loop = true; src.start(0, ini);
    if (pn) pn.pan.value = pan;
    src.connect(g); (pn ? g.connect(pn) : g).connect(pneu.hp);
    pneu.camadas.push({ src, tom });
  });
  pneu.hp.connect(pneu.pico).connect(pneu.g).connect(bus.drive);
  // vento na carroceria
  wind = { src: loopNoise(), bp: filter('bandpass', 900, .4), g: gainNode(0) };
  wind.src.connect(wind.bp).connect(wind.g).connect(bus.drive);
  // ambiente: grilos à noite (oscilador modulado)
  ambience = { cricket: ctx.createOscillator(), cg: gainNode(0), lfo: ctx.createOscillator(), lfoG: gainNode(0) };
  ambience.cricket.frequency.value = 4700; ambience.cricket.type = 'sine';
  ambience.lfo.frequency.value = 28; ambience.lfo.connect(ambience.lfoG.gain);
  ambience.cricket.connect(ambience.lfoG).connect(ambience.cg).connect(bus.drive);
  ambience.lfo.start(); ambience.cricket.start();
}

function enable() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw Error('Web Audio não suportada');
    if (!ctx) { ctx = new AC(); buildGraph(); }
    ctx.resume();
    carregarSons();
    A.enabled = true;
    V.log('Áudio do simulador ativado', 'audio');
    blink(true);
  } catch (e) { V.log('Áudio não disponível: ' + e.message, 'error'); }
  syncButton();
}
function disable() {
  A.enabled = false;
  if (ctx) ctx.suspend().catch(() => {});
  speechSynthesis?.cancel?.();
  V.log('Áudio desligado', 'audio');
  syncButton();
}
function syncButton() { document.getElementById('soundToggle').checked = A.enabled; }

/* ---------- efeitos pontuais ---------- */
function tone(freq, dur, type = 'sine', vol = .12, delay = 0, endFreq = null, dest = bus.alert, pan = 0) {
  if (!A.enabled) return;
  const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(.0002, vol), t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  let node = o.connect(g);
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
  node.connect(dest); o.start(t); o.stop(t + dur + .05);
}
function burst(dur, vol, f0, f1, type = 'bandpass', pan0 = 0, pan1 = 0, dest = bus.drive) {
  if (!A.enabled) return;
  const t = ctx.currentTime, s = ctx.createBufferSource(), f = filter(type, f0, .9), g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(vol, t + dur * .45); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  let n = s.connect(f).connect(g);
  if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.setValueAtTime(pan0, t); p.pan.linearRampToValueAtTime(pan1, t + dur); n = n.connect(p); }
  n.connect(dest); s.start(t); s.stop(t + dur + .05);
}
// passagem de um veículo ao lado (ultrapassando ou sendo ultrapassado): sopro com queda de tom,
// do lado em que ele está, mais forte quanto maior a diferença de velocidade
function passing(t) {
  if (t.rel < 15) return;
  const truck = !!V.VEHICLE_TYPES[t.kind]?.heavy, rel = t.rel / 90, lado = Math.sign(t.x - (V.ROAD.egoLaneX + world.egoOffset)) || -1;
  const dur = truck ? 1.1 : .7, vol = clamp(rel, .25, 1.1);
  burst(dur, (truck ? .45 : .26) * vol, 1400, 300, 'bandpass', lado * .3, lado * .85);
  tone(truck ? 110 : 190, dur, 'sawtooth', (truck ? .04 : .02) * vol, 0, truck ? 70 : 120, bus.drive, lado * .6);
}
function blink(on) { tone(on ? 1400 : 950, .03, 'square', on ? .05 : .035); burst(.04, .12, on ? 3000 : 2200, 2000, 'highpass', 0, 0, bus.alert); }
function horn(intensity = 1) {
  if (!A.enabled) return;
  const truck = state.vehicle === 'truck';
  if (sample(truck ? 'grave' : 'classica', { inicio: truck ? .9 : .7, dur: truck ? .3 : .5, vol: .9 * intensity })) return;
  const f = truck ? [185, 233, 277] : [349, 440];
  f.forEach(fr => tone(fr, truck ? .9 : .5, 'square', .05 * intensity, 0, null, bus.alert));
  f.forEach(fr => tone(fr * 1.005, truck ? .9 : .5, 'sawtooth', .03 * intensity, 0, null, bus.alert));
}
function chime(strong) {
  if (strong) { [880, 1175, 880].forEach((f, i) => tone(f, .18, 'sine', .16, i * .2)); tone(1568, .25, 'triangle', .08, .6); }
  else { tone(659, .35, 'sine', .11); tone(988, .5, 'sine', .1, .22); }
}
// Intervenção: a sirene e, junto, a mesma buzina tocada em toques seguidos, como um alarme.
const ALARME_TOQUES = 3, ALARME_INTERVALO = .5, ALARME_DUR = .36;
function siren() {
  for (let i = 0; i < 4; i++) { tone(960, .14, 'square', .1, i * .3); tone(720, .14, 'square', .1, i * .3 + .15); }
  for (let i = 0; i < ALARME_TOQUES; i++) sample('forte', { inicio: .05, dur: ALARME_DUR, vol: .9, delay: i * ALARME_INTERVALO });
}

/* Buzinadas do tráfego quando o ego fecha alguém ou o segura atrás dele: dois toques seguidos, com
 * volume, panorâmica e tom acompanhando a posição do veículo (Doppler). Cada buzinada fica ligada
 * ao veículo até terminar. */
const buzinadas = [];
let ultimaBuzinada = -1e9;
function buzinar(t) {
  // t.toques = 2: exatamente duas buzinadas curtas (quem espera atrás do ego parado)
  const pesado = !!V.VEHICLE_TYPES[t.kind]?.heavy, nome = pesado ? 'grave' : t.toques === 2 ? 'classica' : Math.random() < .5 ? 'dois' : 'classica';
  const toques = nome === 'dois' ? [{ inicio: 0, dur: .9 }]
    : nome === 'grave' ? [{ inicio: .05, dur: .22 }, { inicio: .05, dur: .22, delay: .32 }]
    : [{ inicio: .05, dur: .18 }, { inicio: .05, dur: .18, delay: .28 }];
  for (const tq of toques) {
    const s = sample(nome, { ...tq, vol: 0, dest: bus.drive, pan: 0 });
    if (s) buzinadas.push({ s, id: t.id, ...tq });
  }
}
function atualizarBuzinadas() {
  const agora = ctx.currentTime;
  for (let i = buzinadas.length - 1; i >= 0; i--) {
    const b = buzinadas[i], t = world.traffic.find(v => v.id === b.id);
    if (agora > b.s.fim + .1) { buzinadas.splice(i, 1); continue; }
    const z = t ? t.z : -200, perto = clamp(1 - Math.abs(z) / 130, 0, 1);
    b.s.g.gain.setTargetAtTime(.9 * perto * perto * state.volume * 1.6, agora, .03);
    const dx = t ? t.x - (V.ROAD.egoLaneX + world.egoOffset) : 0;
    if (b.s.p) b.s.p.pan.setTargetAtTime(clamp(dx / 4, -.8, .8), agora, .05);
    // Doppler: quanto ele se aproxima do ego (mesmo sentido: a diferença de velocidade)
    const aprox = t ? -Math.sign(z) * (t.kmh - state.speed) / 3.6 : 0;
    b.s.src.playbackRate.setTargetAtTime(clamp(1 + aprox / 343, .85, 1.18), agora, .05);
  }
}
let birdTimer = 2, cityTimer = 4;
function distantHorn() {
  const f = 300 + Math.random() * 180, pan = (Math.random() - .5) * 1.6;
  tone(f, .28, 'square', .012, 0, null, bus.drive, pan); tone(f * 1.26, .28, 'square', .008, 0, null, bus.drive, pan);
}
function bird() {
  const base = 2600 + Math.random() * 1800, n = 2 + Math.floor(Math.random() * 4), pan = (Math.random() - .5) * 1.6;
  for (let i = 0; i < n; i++) tone(base, .07, 'sine', .018, i * .11, base * (1.2 + Math.random() * .4), bus.drive, pan);
}

/* ---------- voz ---------- */
function speak(text) {
  if (!A.enabled || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR'; u.rate = 1.02; u.pitch = 1; u.volume = clamp(state.volume * 1.8, .2, 1);
  const voice = speechSynthesis.getVoices().find(v => /pt[-_]BR/i.test(v.lang));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

/* ---------- atualização contínua ---------- */
function update(dt) {
  if (!A.enabled || !ctx) return;
  const paused = state.paused, sp = paused ? 0 : state.speed, truck = state.vehicle === 'truck';
  const rpm = world.rpm || 800;
  const f = rpm / 60 * (truck ? 3 : 2); // explosões por segundo (diesel 6 cil. / 4 cil.)
  const carga = paused ? 0 : world.carga || 0, giroRel = clamp(rpm / (truck ? 2300 : 6200), 0, 1);
  // Motor: forte acelerando; ao soltar, baixa aos poucos, mas não some em movimento: fica um fundo
  // que cresce com a velocidade (em alta, o motor continua bem audível). Parado ou bem devagar,
  // quase silêncio (sem o ronco contínuo de antes).
  const fundo = clamp(sp / (truck ? 110 : 190), 0, 1) * .55;
  // Volume único e contínuo (sem degraus): o maior entre o pé no acelerador e o fundo da velocidade;
  // o fundo some de 20 km/h até parar (parado e sem acelerar: silêncio). Sobe rápido e desce devagar.
  const alvoMotor = paused ? 0 : Math.max(clamp(carga / .4, 0, 1), fundo * clamp(sp / 20, 0, 1));
  A.motor = (A.motor || 0) + (alvoMotor - (A.motor || 0)) * clamp(dt * (alvoMotor > (A.motor || 0) ? 7 : 2), 0, 1);
  const acel = A.motor;
  engine.oscs.forEach(({ o, mul }) => ramp(o.frequency, f * mul, .06));
  if (truck) {
    // Caminhão: diesel grave e batido. Sem o assobio de turbo de carro; admissão grave e baixa.
    ramp(engine.lp.frequency, 230 + rpm * .12 + carga * 380, .1);
    ramp(engine.out.gain, .24 * (.55 + giroRel * .5) * (.75 + carga * .5) * acel, .05);
    ramp(engine.adm.bp.frequency, 110 + rpm * .09, .08);
    ramp(engine.adm.g.gain, carga * .05 * (.4 + giroRel), .12);
    ramp(engine.turbo.g.gain, 0, .1);
    ramp(engine.diesel.mod.frequency, f, .06);
    ramp(engine.diesel.modG.gain, .5, .1); ramp(engine.diesel.amp.gain, .5, .1); // pulsa entre 0 e 1
    ramp(engine.diesel.bp.frequency, 800 + rpm * .35, .1);
    ramp(engine.diesel.g.gain, .5 * (.35 + giroRel * .65), .12);
  } else {
    // pé no acelerador: mais alto e mais aberto (o filtro deixa passar os harmônicos agudos)
    ramp(engine.lp.frequency, 420 + rpm * .16 + carga * 1300, .1);
    ramp(engine.out.gain, .13 * (.5 + giroRel * .55) * (.7 + carga * .65) * acel, .05);
    ramp(engine.adm.bp.frequency, 180 + rpm * .11, .08);
    ramp(engine.adm.g.gain, carga * .09 * (.4 + giroRel), .12);
    ramp(engine.turbo.o.frequency, 1800 + rpm * .55, .1);
    ramp(engine.turbo.g.gain, carga * giroRel * .01, .2);
    ramp(engine.diesel.g.gain, 0, .1);
  }
  ramp(engine.rumbleGain.gain, truck ? .55 : .2, .3);
  cantarPneus(paused, sp, truck);
  limitador(paused);
  buzinaLaco('contra', world.contraAlerta, paused);
  desacelAoAcelerar();
  // rolagem dos pneus: desligada (era um som contínuo de movimento o tempo todo)
  ramp(road.g.gain, 0, .25);
  // vento: acima de 60 km/h, mais forte quanto mais rápido e quanto mais acelera; ao manter ou
  // reduzir, baixa aos poucos até um fundo que cresce com a velocidade (em alta, o vento predomina).
  const ganho = dt > 0 && !paused ? (sp - (A.spAnterior ?? sp)) / dt : 0; A.spAnterior = sp;
  A.acelera = (A.acelera || 0) + (clamp(ganho / 6, 0, 1) - (A.acelera || 0)) * clamp(dt * (ganho > .5 ? 3 : 1.2), 0, 1);
  const vel = clamp((sp - 60) / 120, 0, 1.25), ventoFundo = clamp((sp - 80) / 120, 0, 1) * .7;
  ramp(wind.g.gain, vel * vel * .14 * Math.max(A.acelera, ventoFundo), .5); ramp(wind.bp.frequency, 500 + sp * 9, .3);
  // ambiente
  ramp(ambience.cg.gain, paused ? 0 : clamp(env.night * 1.4 - .3, 0, 1) * .012, .8);
  const city = V.cityAmount(world.distance) > .5;
  if (!paused && !city && env.night < .4) { birdTimer -= dt; if (birdTimer < 0) { birdTimer = 2.5 + Math.random() * 6; if (sp < 100) bird(); } }
  // cidade: buzinas distantes de vez em quando
  if (!paused && city) { cityTimer -= dt; if (cityTimer < 0) { cityTimer = 6 + Math.random() * 10; distantHorn(); } }
  ramp(master.gain, state.volume, .1);
  atualizarBuzinadas();
}

/* Guincho de pneu (borracha travada arrastando no asfalto), gerado uma vez em 3 s de laço:
 *  - um tom agudo (~1,25 kHz) com harmônicos, que nunca fica parado: a afinação desvia devagar e
 *    de forma irregular (ruído suave, não um vibrato regular) e treme rápido por cima;
 *  - aspereza do "agarra e solta" da borracha: o volume pulsa irregularmente a ~70-140 Hz;
 *  - um chiado de arrasto (ruído) por baixo, mais forte quando o tom enfraquece.
 * O fim do laço é misturado ao começo (sem estalo na emenda). */
function guinchoPneu() {
  const sr = ctx.sampleRate, dur = 3, X = Math.round(sr * .25), N = Math.round(sr * dur);
  const tot = N + X, d = new Float32Array(tot);
  // ruído suave: valores aleatórios em pontos espaçados, interpolados (cosseno)
  const suave = (taxa, seed) => {
    const n = Math.ceil((dur + .3) * taxa) + 2, v = new Float32Array(n);
    let s = seed; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; v[i] = s / 2147483648 - 1; }
    return t => { const x = t * taxa, i = Math.floor(x), f = x - i, w = (1 - Math.cos(f * Math.PI)) / 2; return v[i] * (1 - w) + v[i + 1] * w; };
  };
  const deriva = suave(3.5, 11), treme = suave(28, 23), aspero = suave(110, 37), corpo = suave(1.6, 41);
  const harm = [1, .55, .38, .22, .12, .07];
  let fase = 0, ruido = 0, max = 0;
  for (let i = 0; i < tot; i++) {
    const t = i / sr;
    const f = 1250 * (1 + .055 * deriva(t) + .018 * treme(t));
    fase += 2 * Math.PI * f / sr;
    let tom = 0;
    for (let h = 0; h < harm.length; h++) tom += harm[h] * Math.sin(fase * (h + 1) + h * .7);
    const rugo = .62 + .38 * aspero(t), forca = .8 + .2 * corpo(t);
    ruido = ruido * .6 + (Math.random() * 2 - 1) * .4; // chiado, um pouco abafado
    d[i] = (tom * rugo + ruido * (.35 + .25 * (1 - rugo))) * forca;
    max = Math.max(max, Math.abs(d[i]));
  }
  const b = ctx.createBuffer(1, N, sr), o = b.getChannelData(0);
  for (let i = 0; i < N; i++) {
    let v = d[i];
    if (i < X) { const w = i / X; v = d[i] * w + d[N + i] * (1 - w); } // emenda do laço
    o[i] = v / max;
  }
  return b;
}
/* Pneus cantando (world.cantando 0..1, calculado em core.js na frenagem brusca): entra rápido e
 * some em ~0,1 s ao soltar o freio. O tom cai junto com a velocidade (no fim, um guincho mais
 * grave antes de parar); o caminhão, pneus maiores, é mais grave. */
function cantarPneus(paused, sp, truck) {
  const k = paused ? 0 : world.cantando || 0;
  const rate = (truck ? .66 : .84) + clamp(sp / 130, 0, 1) * (truck ? .16 : .26);
  for (const { src, tom } of pneu.camadas) ramp(src.playbackRate, rate * tom, .12);
  ramp(pneu.g.gain, k * (truck ? .2 : .24), k > (A.pneu || 0) ? .025 : .07);
  A.pneu = k;
}

/* ---------- ligações com o núcleo ---------- */
// Áudio ligado por padrão. O navegador só libera o som após a primeira interação
// (clique ou tecla); até lá o contexto fica suspenso e é retomado nesse momento.
V.on('ready', () => {
  document.getElementById('soundToggle').onchange = e => e.target.checked ? enable() : disable();
  enable();
  const liberar = () => { if (A.enabled && ctx?.state === 'suspended') ctx.resume(); };
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, liberar, { capture: true });
});
V.on('pass', t => passing(t));
// Troca de marcha (câmbio automático): o motor corta por um instante e volta no novo giro, com o
// "toc" do câmbio. Subindo com o pé no fundo, o alívio do turbo (carro) ou do ar (caminhão).
// Fator de volume perto de parar: 1 acima de 20 km/h, cai até 0 parado (acelerando, sempre 1).
const quaseParado = () => Math.max(clamp((world.carga || 0) / .4, 0, 1), clamp(state.speed / 20, 0, 1));
V.on('marcha', m => {
  if (!A.enabled || !ctx) return;
  const perto = quaseParado();
  if (perto < .05) return; // parando: sem tranco nem ronco de redução
  const t = ctx.currentTime, g = engine.troca.gain, truck = state.vehicle === 'truck';
  g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
  if (m.sobe) {
    // subindo: o motor corta por um instante e volta no giro mais baixo
    g.linearRampToValueAtTime(.3, t + .05); g.setValueAtTime(.3, t + .16); g.linearRampToValueAtTime(1, t + .32);
  } else if (!m.acelerando) {
    // reduzindo sem acelerar: o giro sobe ("vrum" da redução) e o motor segura o carro (freio-motor)
    g.linearRampToValueAtTime(1.8, t + .07); g.setValueAtTime(1.8, t + .2); g.linearRampToValueAtTime(1, t + .65);
    reducao(truck, m.carga, perto);
  } else {
    // kickdown (reduz porque o pé afundou): o próprio motor sobe de giro; nenhum ronco extra por cima
    g.linearRampToValueAtTime(1, t + .05);
  }
  tone(truck ? 55 : 75, .1, 'sine', .14 * perto, .04, truck ? 40 : 55, bus.drive);          // tranco do câmbio
  burst(.05, .08 * perto, truck ? 1200 : 2000, 900, 'bandpass', .2, .2);                   // "toc" metálico
  if (m.sobe && m.carga > .55) burst(truck ? .45 : .3, truck ? .16 : .1, truck ? 5000 : 3800, 1400, 'highpass', 0, 0);
});
const f0 = () => (world.rpm || 800) / 60 * (state.vehicle === 'truck' ? 3 : 2); // explosões por segundo
/* Redução de marcha: o giro sobe de repente e volta a cair devagar (o motor segurando o carro).
 * Um ronco próprio (dente de serra filtrado), independente do volume do motor, para a redução
 * ser ouvida mesmo em velocidade baixa com o pé fora do acelerador. Depois, no carro, uns
 * estalinhos de escapamento em desaceleração; no caminhão, o "trrr" do freio-motor. */
// Todo o som de desaceleração (ronco da redução e estalos) passa por um canal próprio, para sumir
// em ~0,15 s se o motorista voltar a acelerar enquanto ele ainda toca (veja desacelAoAcelerar).
let canalDesacel = null;
function reducao(truck, carga, perto = 1) {
  if (canalDesacel) canalDesacel.gain.setTargetAtTime(0, ctx.currentTime, .03);
  const canal = canalDesacel = ctx.createGain(); canal.connect(bus.drive);
  const t = ctx.currentTime, base = f0(), sobe = truck ? 1.35 : 1.45, vol = (truck ? .11 : .08) * (1 + carga * .5) * perto;
  for (const [mul, tipo, v] of [[1, 'sawtooth', 1], [2, 'square', .35], [.5, 'sine', .8]]) {
    const o = ctx.createOscillator(), lp = filter('lowpass', truck ? 500 : 900, 1.1), ga = ctx.createGain();
    o.type = tipo;
    o.frequency.setValueAtTime(base * mul, t);
    o.frequency.exponentialRampToValueAtTime(base * mul * sobe, t + .12);              // o giro sobe
    o.frequency.exponentialRampToValueAtTime(base * mul * (sobe - .12), t + .7);       // e vai caindo
    ga.gain.setValueAtTime(.0001, t); ga.gain.exponentialRampToValueAtTime(vol * v, t + .06);
    ga.gain.setValueAtTime(vol * v, t + .25); ga.gain.exponentialRampToValueAtTime(.0001, t + .8);
    o.connect(lp).connect(ga).connect(canal); o.start(t); o.stop(t + .85);
  }
  setTimeout(() => { if (canalDesacel === canal) canalDesacel = null; canal.disconnect(); }, 1600);
  if (truck) for (let i = 0; i < 9; i++) impacto(.03, .07 * perto, 420, 220, { tipo: 'lowpass', q: 1.5, delay: .15 + i * .045, dest: canal });
  else for (let i = 0; i < 3; i++) impacto(.03, (.08 + Math.random() * .06) * perto, 1200 + Math.random() * 800, 400, { tipo: 'lowpass', ataque: .001, delay: .3 + i * .09 + Math.random() * .06, dest: canal });
}
// Transição: pisou no acelerador com um som de desaceleração ainda tocando? Ele some em ~0,15 s e o
// reforço do motor da redução volta ao normal, para os dois nunca tocarem juntos.
let acelerandoAntes = false;
function desacelAoAcelerar() {
  const ac = !!world.acelerando;
  if (ac && !acelerandoAntes) {
    const t = ctx.currentTime;
    if (canalDesacel) { canalDesacel.gain.cancelScheduledValues(t); canalDesacel.gain.setTargetAtTime(0, t, .05); canalDesacel = null; }
    const g = engine.troca.gain;
    if (g.value > 1.01) { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(1, t + .15); }
  }
  acelerandoAntes = ac;
}
/* Limitador de giro na velocidade máxima, com o pé no fundo: o motor corta e volta a cada 0,1 s
 * (0,065 s ligado, 0,035 s cortado), com um estalo no escapamento a cada corte. Os cortes são
 * agendados até 0,2 s à frente no relógio do áudio, para o ritmo não depender da taxa de quadros. */
let limProx = 0;
function limitador(paused) {
  const g = engine.corte.gain, agora = ctx.currentTime;
  if (!world.limitador || paused) {
    if (limProx) { g.cancelScheduledValues(agora); g.setTargetAtTime(1, agora, .02); limProx = 0; }
    return;
  }
  if (limProx < agora) limProx = agora + .01;
  const truck = state.vehicle === 'truck';
  while (limProx < agora + .2) {
    const t = limProx;
    g.setValueAtTime(1, t); g.setValueAtTime(.08, t + .065);
    impacto(.035, truck ? .1 : .14, truck ? 500 : 900, 250, { tipo: 'lowpass', q: 1.2, delay: t + .066 - agora, dest: bus.drive });
    limProx += .1;
  }
}

/* Tiro no escapamento (muito tempo no limitador): estalo seco e forte vindo de trás, um baque
 * grave e dois ou três estalinhos de combustão logo depois. */
V.on('estouro', e => {
  if (!A.enabled || !ctx) return;
  const f = e.forca, truck = state.vehicle === 'truck';
  impacto(.09, 1.1 * f, truck ? 2200 : 3800, 300, { tipo: 'lowpass', q: .9, ataque: .001, dest: bus.drive });
  impacto(.04, .6 * f, 5000, 2500, { tipo: 'highpass', q: .7, ataque: .001, dest: bus.drive });
  tone(truck ? 50 : 68, .18, 'sine', .6 * f, 0, 35, bus.drive);
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) impacto(.03, (.25 + Math.random() * .2) * f, 1800 + Math.random() * 1500, 500, { tipo: 'lowpass', ataque: .001, delay: .05 + i * .045 + Math.random() * .03, dest: bus.drive });
});

/* ---------- batidas ----------
 * Dois sons, escolhidos pela diferença de velocidade no choque (c.rel, km/h):
 *  - leve (até 30 km/h): baque abafado de para-choque, estalo de plástico e um chacoalhar curto;
 *  - forte (acima de 30): estrondo grave, lataria amassando (ruído rasgado que desce de tom),
 *    ressonâncias metálicas, vidro estilhaçando e destroços caindo; os pneus arrastam no fim.
 * Na batida lateral, um raspão de lataria (ruído agudo que arrasta) entra junto.
 * Tudo vem do lado do outro veículo (c.lado) e vai pelo canal de alertas (nunca abafado). */
// Ruído com ataque imediato e queda exponencial, filtrado (freq de f0 para f1 ao longo de dur).
function impacto(dur, vol, f0, f1, { tipo = 'bandpass', q = 1, pan = 0, delay = 0, ataque = .004, dest = bus.alert } = {}) {
  if (!A.enabled) return;
  const t = ctx.currentTime + delay, s = ctx.createBufferSource(), f = filter(tipo, f0, q), g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true; s.playbackRate.value = .8 + Math.random() * .4;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(.0002, vol), t + ataque);
  g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  let n = s.connect(f).connect(g);
  if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); n = n.connect(p); }
  n.connect(dest); s.start(t, Math.random() * 1.5); s.stop(t + dur + .05);
}
// Ressonância metálica: parciais inarmônicos que somem em tempos diferentes.
function metal(base, dur, vol, pan, delay = 0) {
  [1, 2.32, 3.67, 5.11].forEach((k, i) => tone(base * k * (.98 + Math.random() * .04), dur / (1 + i * .5), i ? 'sine' : 'triangle', vol / (1 + i * .8), delay, base * k * .97, bus.alert, pan));
}
function batidaLeve(forca, pan) {
  tone(95, .22, 'sine', .45 * forca, 0, 55, bus.alert, pan);                       // baque abafado
  impacto(.16, .55 * forca, 1400, 300, { tipo: 'lowpass', q: .8, pan });            // para-choque
  impacto(.05, .3 * forca, 2600, 1800, { q: 3, pan, delay: .01 });                  // estalo do plástico
  metal(310, .25, .03 * forca, pan, .015);                                          // lataria vibra de leve
  for (let i = 0; i < 3; i++) impacto(.04, .12 * forca, 3000 + Math.random() * 2000, 2000, { q: 4, pan: pan + (Math.random() - .5) * .3, delay: .12 + i * .07 + Math.random() * .05 }); // chacoalhar
}
function batidaForte(forca, pan) {
  tone(48, .7, 'sine', .75 * forca, 0, 26, bus.alert, pan);                        // estrondo (peso)
  tone(85, .35, 'triangle', .4 * forca, 0, 40, bus.alert, pan);
  impacto(.9, 1.1 * forca, 2200, 120, { tipo: 'lowpass', q: .7, pan });             // explosão do choque
  impacto(.55, .6 * forca, 900, 260, { q: .6, pan, delay: .02 });                   // lataria amassando
  impacto(.4, .35 * forca, 3500, 900, { q: 1.5, pan, delay: .05 });                 // rasgo de chapa
  metal(190, 1.1, .07 * forca, pan, .01);                                           // ressonâncias metálicas
  metal(470, .7, .05 * forca, -pan * .4, .06);
  // vidro: estouro agudo seguido de cacos tilintando
  impacto(.3, .5 * forca, 7000, 4500, { tipo: 'highpass', q: .7, pan, delay: .04 });
  for (let i = 0; i < 16; i++) tone(2800 + Math.random() * 5200, .05 + Math.random() * .12, 'sine', .035 * forca, .08 + Math.random() * .7, null, bus.alert, pan + (Math.random() - .5) * .9);
  // destroços caindo no asfalto
  for (let i = 0; i < 7; i++) impacto(.06 + Math.random() * .08, (.18 + Math.random() * .2) * forca, 600 + Math.random() * 2400, 400, { q: 2, pan: pan + (Math.random() - .5) * .8, delay: .35 + Math.random() * 1.1 });
  // pneus arrastando enquanto os dois param
  impacto(1.2, .16 * forca, 1700, 1100, { q: 6, pan, delay: .25, ataque: .15 });
}
function raspao(forca, pan) {
  impacto(.6, .35 * forca, 3200, 1500, { q: 2.5, pan, ataque: .02 });
  impacto(.5, .2 * forca, 1200, 700, { q: 3, pan, delay: .05, ataque: .03 });
}
V.on('colisao', c => {
  if (!A.enabled || !ctx) return;
  const pan = clamp((c.lado || 0) * .55, -.7, .7), forte = c.rel > 30;
  if (forte) batidaForte(clamp(.7 + (c.rel - 30) / 100, .7, 1.25), pan);
  else batidaLeve(clamp(.55 + c.rel / 60, .55, 1), pan);
  if (c.tipo === 'lateral') raspao(forte ? 1 : .7, pan);
});
// Mãos frouxas no volante (pressao.js): o nível sobe para ATENÇÃO, e a voz dele já pede firmeza.
// Se o nível já estava acima do normal (o modelo viu sono), só a voz pedindo firmeza.
V.on('volanteFrouxo', () => {
  if (!A.enabled || V.state.level === 'normal' || V.state.degraded) return;
  tone(740, .22, 'sine', .14); tone(990, .3, 'sine', .13, .26);
  setTimeout(() => speak('Segure firme no volante.'), 650);
});
V.on('buzinaTrafego', t => { if (A.enabled && ctx && (t.toques === 2 || ctx.currentTime - ultimaBuzinada > 3)) { ultimaBuzinada = ctx.currentTime; buzinar(t); } });
V.on('blink', on => blink(on));
// Buzina do motorista (centro do volante, tecla H): um único som, que toca enquanto o botão
// estiver apertado. O toque longo de cada gravação (o mais estável) é repetido em laço:
//   carro     buzina_classica, ataque em 1,82 s e laço em 2,05-2,75 s (volume varia só 2%)
//   caminhão  buzina_grave, ataque em 2,86 s e laço em 3,00-3,45 s
// Um toque rápido dá uma buzinada curta (mínimo de 0,22 s).
const BUZINA = { car: { nome: 'classica', inicio: 1.82, laco: [2.05, 2.75] }, truck: { nome: 'grave', inicio: 2.86, laco: [3.0, 3.45] } };
const BUZINA_MIN = .22;
let buzinando = null;
function buzinaInicio() {
  if (!A.enabled) enable();
  if (buzinando || !ctx) return;
  const b = BUZINA[state.vehicle === 'truck' ? 'truck' : 'car'], buf = buffers[b.nome];
  if (!buf) { horn(1); return; } // arquivo ainda não carregado: buzina sintetizada curta
  const t = ctx.currentTime, src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf; src.loop = true; src.loopStart = b.laco[0]; src.loopEnd = b.laco[1];
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + .015);
  src.connect(g).connect(bus.alert); src.start(t, b.inicio);
  buzinando = { src, g, t0: t };
}
function buzinaFim() {
  const b = buzinando; if (!b) return;
  buzinando = null;
  const t = Math.max(ctx.currentTime, b.t0 + BUZINA_MIN);
  b.g.gain.setValueAtTime(1, t); b.g.gain.linearRampToValueAtTime(0, t + .06);
  b.src.stop(t + .08);
}
/* Buzina contínua do tráfego, em laço enquanto durar o motivo: quem vem de frente na contramão
 * com o ego na faixa dele (world.contraAlerta). Mais alta quanto mais perto, vinda do lado dele. */
const lacos = {};
function buzinaLaco(chave, T, paused) {
  if (paused) T = null;
  let L = lacos[chave];
  if (L && (!T || L.id !== T.id)) {
    const t = ctx.currentTime; lacos[chave] = L = null;
    const b = lacos['_' + chave]; delete lacos['_' + chave];
    if (b) { b.g.gain.cancelScheduledValues(t); b.g.gain.setTargetAtTime(0, t, .03); b.src.stop(t + .2); }
  }
  if (!T) return;
  if (!L) {
    const b = BUZINA[V.VEHICLE_TYPES[T.kind]?.heavy ? 'truck' : 'car'], buf = buffers[b.nome];
    if (!buf) return; // arquivo ainda não carregado
    const t = ctx.currentTime, src = ctx.createBufferSource(), g = gainNode(0), p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.buffer = buf; src.loop = true; src.loopStart = b.laco[0]; src.loopEnd = b.laco[1];
    src.connect(g); (p ? g.connect(p) : g).connect(bus.drive); src.start(t, b.inicio);
    lacos[chave] = L = { id: T.id }; lacos['_' + chave] = { src, g, p };
  }
  const n = lacos['_' + chave], perto = clamp(1.15 - Math.abs(T.z) / 80, .4, 1);
  ramp(n.g.gain, .85 * perto, .04);
  if (n.p) ramp(n.p.pan, clamp((T.x - (V.ROAD.egoLaneX + world.egoOffset)) / 8, -.8, .8), .1);
}
V.on('buzinaInicio', buzinaInicio);
V.on('buzinaFim', buzinaFim);
V.on('horn', () => { buzinaInicio(); buzinaFim(); }); // buzinada curta
V.on('level', l => {
  if (l === 'attention') { chime(false); speak(V.pressao?.frouxo ? 'Atenção. Segure firme no volante.' : 'Atenção. Sinais de fadiga detectados. Considere fazer uma pausa.'); }
  else if (l === 'critical') { chime(true); speak('Alerta. Confirme que está atento.'); }
  else if (l === 'intervention') { siren(); setTimeout(() => speak('Possível sonolência detectada. Reduzindo a velocidade com segurança.'), 1300); }
  else if (l === 'degraded') tone(440, .4, 'triangle', .08);
});
V.on('alarm', l => { if (l === 'attention') chime(false); else if (l === 'critical') chime(true); else siren(); });
V.addRenderer(dt => update(dt), 'audio');
A.enable = enable; A.disable = disable; A.speak = speak;
})();
