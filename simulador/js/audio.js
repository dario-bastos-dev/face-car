/* VIGIA v0.6 — áudio do simulador (Web Audio, sintetizado no navegador).
 * Motor ligado à rotação, rolagem de pneus, vento, passagens com Doppler,
 * ambiente diurno/noturno, pisca-alerta, buzina e alertas com voz. */
(() => {
'use strict';
const V = window.VIGIA;
const { state, world, env, clamp } = V;

const A = V.audio = { enabled: false };
let ctx, master, bus = {}, engine, road, wind, ambience, noiseBuf;

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
  engine.lp.connect(engine.out).connect(bus.drive);

  // rolagem dos pneus no asfalto
  road = { src: loopNoise(), lp: filter('lowpass', 500), g: gainNode(0) };
  road.src.connect(road.lp).connect(road.g).connect(bus.drive);
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
// passagem de veículo no sentido oposto (à esquerda), com queda de tom (Doppler)
function passing(t) {
  const truck = !!V.VEHICLE_TYPES[t.kind]?.heavy, rel = (state.speed + t.kmh) / 160;
  const dur = truck ? 1.25 : .8;
  burst(dur, (truck ? .5 : .3) * clamp(rel, .4, 1.2), 1600, 280, 'bandpass', -.2, -.85);
  tone(truck ? 120 : 210, dur, 'sawtooth', truck ? .05 : .025, 0, truck ? 70 : 130, bus.drive, -.6);
  if (truck && Math.random() < .12) setTimeout(() => horn(.35), 120);
}
function blink(on) { tone(on ? 1400 : 950, .03, 'square', on ? .05 : .035); burst(.04, .12, on ? 3000 : 2200, 2000, 'highpass', 0, 0, bus.alert); }
function horn(intensity = 1) {
  if (!A.enabled) return;
  const truck = state.vehicle === 'truck';
  const f = truck ? [185, 233, 277] : [349, 440];
  f.forEach(fr => tone(fr, truck ? .9 : .5, 'square', .05 * intensity, 0, null, bus.alert));
  f.forEach(fr => tone(fr * 1.005, truck ? .9 : .5, 'sawtooth', .03 * intensity, 0, null, bus.alert));
}
function chime(strong) {
  if (strong) { [880, 1175, 880].forEach((f, i) => tone(f, .18, 'sine', .16, i * .2)); tone(1568, .25, 'triangle', .08, .6); }
  else { tone(659, .35, 'sine', .11); tone(988, .5, 'sine', .1, .22); }
}
function siren() { for (let i = 0; i < 4; i++) { tone(960, .14, 'square', .1, i * .3); tone(720, .14, 'square', .1, i * .3 + .15); } }

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
  const f = rpm / 60 * (truck ? 3 : 2); // disparos por segundo (6 cil. / 4 cil.)
  engine.oscs.forEach(({ o, mul }) => ramp(o.frequency, f * mul * (truck ? .5 : 1), .08));
  ramp(engine.lp.frequency, (truck ? 280 : 420) + rpm * (truck ? .18 : .22), .1);
  ramp(engine.out.gain, paused ? 0 : (truck ? .2 : .13) * (.55 + clamp(rpm / 3000, 0, 1) * .6), .2);
  ramp(engine.rumbleGain.gain, truck ? .55 : .2, .3);
  // cabine fechada: vento e pneu crescem com a velocidade
  const v = clamp(sp / 120, 0, 1.4);
  ramp(road.g.gain, v * .22, .25); ramp(road.lp.frequency, 250 + sp * 7, .25);
  ramp(wind.g.gain, v * v * .12, .3); ramp(wind.bp.frequency, 500 + sp * 9, .3);
  // ambiente
  ramp(ambience.cg.gain, paused ? 0 : clamp(env.night * 1.4 - .3, 0, 1) * .012, .8);
  const city = V.cityAmount(world.distance) > .5;
  if (!paused && !city && env.night < .4) { birdTimer -= dt; if (birdTimer < 0) { birdTimer = 2.5 + Math.random() * 6; if (sp < 100) bird(); } }
  // cidade: buzinas distantes de vez em quando
  if (!paused && city) { cityTimer -= dt; if (cityTimer < 0) { cityTimer = 6 + Math.random() * 10; distantHorn(); } }
  ramp(master.gain, state.volume, .1);
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
V.on('blink', on => blink(on));
V.on('horn', () => { if (!A.enabled) enable(); horn(1); });
V.on('level', l => {
  if (l === 'attention') { chime(false); speak('Atenção. Sinais de fadiga detectados. Considere fazer uma pausa.'); }
  else if (l === 'critical') { chime(true); speak('Alerta. Confirme que está atento.'); }
  else if (l === 'intervention') { siren(); setTimeout(() => speak('Possível sonolência detectada. Reduzindo a velocidade com segurança.'), 1300); }
  else if (l === 'degraded') tone(440, .4, 'triangle', .08);
});
V.on('alarm', l => { if (l === 'attention') chime(false); else if (l === 'critical') chime(true); else siren(); });
V.addRenderer(dt => update(dt));
A.enable = enable; A.disable = disable; A.speak = speak;
})();
