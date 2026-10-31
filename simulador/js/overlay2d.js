/* VIGIA v0.6 — painéis sobrepostos da visão 2D (painel do veículo, ambiente, tráfego).
 * O cartão da câmera/monitoramento é controlado por driver-monitor.js. */
(() => {
'use strict';
const V = window.VIGIA;
const { state, world, clamp, lerp } = V;
const $ = id => document.getElementById(id);

const LEVEL_COLOR = { normal: '#2fe08f', attention: '#ffc44d', critical: '#ff5a4f', intervention: '#ff3b3b', degraded: '#ffb36b' };
const A0 = -125, A1 = 125; // ângulos do mostrador (graus a partir do topo)

function pt(a, r) { const d = a * Math.PI / 180; return [100 + Math.sin(d) * r, 100 - Math.cos(d) * r]; }
function arc(a, b, r = 82) {
  const steps = Math.max(1, Math.ceil(Math.abs(b - a) / 3)); let p = '';
  for (let i = 0; i <= steps; i++) { const [x, y] = pt(a + (b - a) * i / steps, r); p += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }
  return p;
}
function buildGauge() {
  const max = V.VEHICLES[state.vehicle].maxSpeed, ns = 'http://www.w3.org/2000/svg', g = $('ovGaugeTicks');
  g.replaceChildren();
  $('ovGaugeTrack').setAttribute('d', arc(A0, A1));
  for (let v = 0; v <= max; v += 5) {
    const a = A0 + (A1 - A0) * v / max, major = v % 20 === 0, mid = v % 10 === 0;
    const [x1, y1] = pt(a, major ? 64 : mid ? 68 : 71), [x2, y2] = pt(a, 75);
    const l = document.createElementNS(ns, 'line');
    const red = v > max * .78;
    Object.entries({ x1, y1, x2, y2, class: (major ? 'ovg-major' : 'ovg-minor') + (red ? ' red' : '') }).forEach(([k, val]) => l.setAttribute(k, val));
    g.append(l);
    if (major) {
      const [tx, ty] = pt(a, 51), t = document.createElementNS(ns, 'text');
      Object.entries({ x: tx, y: ty + 4, 'text-anchor': 'middle', class: 'ovg-label' }).forEach(([k, val]) => t.setAttribute(k, val));
      t.textContent = v; g.append(t);
    }
  }
}

const cache = {};
let shown = 0; // velocidade exibida (suavizada) para o ponteiro deslizar
function set(id, prop, val) { const k = id + prop; if (cache[k] === val) return; cache[k] = val; if (prop === 'text') $(id).textContent = val; else $(id).style[prop] = val; }
function cls(id, name, on) { $(id).classList.toggle(name, !!on); }

function update(dt) {
  if (state.viewMode !== '2d') return;
  const max = V.VEHICLES[state.vehicle].maxSpeed;
  shown = lerp(shown, state.speed, clamp(dt * 6, 0, 1));
  const frac = clamp(shown / max, 0, 1), ang = A0 + (A1 - A0) * frac;
  $('ovNeedle').setAttribute('transform', `rotate(${ang.toFixed(2)} 100 100)`);
  $('ovGaugeArc').setAttribute('d', arc(A0, Math.max(A0 + .5, ang)));
  set('ovSpeed', 'text', String(Math.round(shown)));
  const lvl = V.effectiveLevel();
  set('ovStatus', 'text', V.LABEL[lvl]);
  set('ovStatus', 'color', LEVEL_COLOR[lvl]);
  set('ovStatus', 'fontSize', V.LABEL[lvl].length > 8 ? '14px' : '');
  set('ovTarget', 'text', 'ALVO: ' + Math.round(state.target) + ' km/h');
  const inter = !state.degraded && state.level === 'intervention';
  cls('ovHazard', 'on', state.hazardOn);
  cls('ovBrake', 'alert', inter && state.speed > .3);
  cls('ovSignal', 'on', !state.degraded);
  cls('ovSignal', 'lost', state.degraded);
}

V.on('ready', () => {
  buildGauge(); shown = state.speed;
});
V.on('vehicle', v => { buildGauge(); $('ovDashName').textContent = 'PAINEL - ' + (v === 'truck' ? 'CAMINHÃO' : 'CARRO FAMILIAR'); });
V.addRenderer(update);
})();
