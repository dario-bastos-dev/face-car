/* VIGIA v0.6 — interior da cabine desenhado sobre o WebGL (Canvas 2D transparente).
 * Colunas, painel, volante, quadro de instrumentos, central multimídia e molduras
 * dos retrovisores. As áreas de vidro ficam transparentes para mostrar a cena 3D. */
(() => {
'use strict';
const V = window.VIGIA;
const { state, world, env, clamp } = V;

let canvas, ctx, W = 0, H = 0, dpr = 1;
let under, over; // camadas estáticas pré-renderizadas
const emblem = new Image(); emblem.src = 'assets/vigia_v.png'; // "V" do volante, sem fundo
emblem.onload = () => { if (W) buildStatic(); };

const cabin = V.cabin = { layout: null, resize };

function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : (c.moveTo(x + r, y), c.arcTo(x + w, y, x + w, y + h, r), c.arcTo(x + w, y + h, x, y + h, r), c.arcTo(x, y + h, x, y, r), c.arcTo(x, y, x + w, y, r), c.closePath()); }
function grad(c, x0, y0, x1, y1, stops) { const g = c.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, col]) => g.addColorStop(o, col)); return g; }
function txt(c, s, x, y, size, color, weight = 700, align = 'left', base = 'alphabetic') {
  c.font = `${weight} ${size}px Inter, "Segoe UI", system-ui, sans-serif`; c.fillStyle = color; c.textAlign = align; c.textBaseline = base; c.fillText(s, x, y);
}

function computeLayout() {
  const truck = state.vehicle === 'truck';
  const narrow = W < 680;
  const dashTop = H * (truck ? .6 : .625);
  const L = { truck, narrow, dashTop, mirrors: {} };
  // Retrovisores laterais logo abaixo do cartão da câmera (canto superior esquerdo).
  const below = id => { const el = document.getElementById(id); return el && el.offsetHeight ? el.offsetTop + el.offsetHeight + 16 : 0; };
  const my = Math.round(Math.max(H * .3, narrow ? 0 : below('cockpitCam')));
  const mw = clamp(W * .105, 64, 150);
  const mh = Math.round(clamp(Math.min(H * (truck ? .22 : .19), dashTop + H * .06 - my), 50, 170));
  L.mirrors.left = { x: Math.round(W * .016), y: my, w: Math.round(mw), h: mh };
  L.mirrors.right = { x: Math.round(W - W * .016 - mw), y: my, w: Math.round(mw), h: mh };
  if (truck) {
    const lh = Math.round(mh * .62);
    L.mirrors.lowL = { x: L.mirrors.left.x + 4, y: L.mirrors.left.y + L.mirrors.left.h + 14, w: Math.round(mw - 8), h: lh };
    L.mirrors.lowR = { x: L.mirrors.right.x + 4, y: L.mirrors.right.y + L.mirrors.right.h + 14, w: Math.round(mw - 8), h: lh };
  }
  const cmW = clamp(W * .24, 150, 340);
  // Retrovisor interno no centro do VEÍCULO: a vista é do banco do motorista (lado esquerdo),
  // então o centro do veículo fica à direita do meio da tela.
  const vehCenter = narrow ? W * .5 : W * (truck ? .64 : .615);
  const cmX = Math.min(vehCenter - cmW / 2, W * .83 - cmW);
  L.mirrors.center = { x: Math.round(cmX), y: Math.round(H * .025), w: Math.round(cmW), h: Math.round(clamp(H * .115, 40, 90)) };
  // quebra-sóis: o do motorista à esquerda (onde fica a câmera VIGIA) e o do passageiro à direita do retrovisor
  const card = document.getElementById('cockpitCam');
  const cardRight = card && card.offsetWidth ? card.offsetLeft + card.offsetWidth + 14 : 0;
  const vx = Math.max(W * .19, cardRight), rvx = L.mirrors.center.x + cmW + W * .012;
  L.visors = [{ x: vx, y: H * .035, w: Math.min(W * .17, L.mirrors.center.x - 14 - vx), h: H * .05 }];
  if (W * .835 - rvx > W * .04) L.visors.push({ x: rvx, y: H * .035, w: W * .835 - rvx, h: H * .05 });
  if (narrow) { delete L.mirrors.lowL; delete L.mirrors.lowR; }

  const wheelCx = narrow ? W * .5 : W * .445;
  const wheelR = narrow ? Math.min(W * .42, H * .44) : Math.min(H * .47, W * .3);
  L.wheel = { cx: wheelCx, cy: H * 1.04, r: wheelR, t: Math.max(14, wheelR * .11) };
  L.cluster = narrow
    ? { x: W * .14, y: dashTop + H * .03, w: W * .72, h: H - dashTop - H * .05 }
    : { x: W * .272, y: dashTop + H * .028, w: W * .352, h: H - dashTop - H * .045 };
  L.screen = narrow ? null : { x: W * .675, y: dashTop + H * .045, w: Math.min(W * .19, L.mirrors.right.x - 22 - W * .675), h: H - dashTop - H * .075 };
  return L;
}

function resize(w, h) {
  canvas = canvas || document.getElementById('cabinCanvas');
  ctx = ctx || canvas.getContext('2d');
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = w; H = h;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  buildStatic();
}
V.on('vehicle', () => { if (W) buildStatic(); });
// os cartões dos cantos mudam de altura (fontes, câmera): reposiciona os retrovisores
V.on('ready', () => {
  const ro = new ResizeObserver(() => { if (W) buildStatic(); });
  ro.observe(document.getElementById('cockpitCam'));
});

function layer() { const c = document.createElement('canvas'); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); const x = c.getContext('2d'); x.scale(dpr, dpr); return [c, x]; }

function buildStatic() {
  const L = cabin.layout = computeLayout();
  let c;
  [under, c] = layer();
  const dt = L.dashTop, truck = L.truck;

  // forro do teto e quebra-sóis
  c.fillStyle = grad(c, 0, 0, 0, H * .09, [[0, '#1b1e22'], [1, '#2a2e33']]);
  c.beginPath(); c.moveTo(0, 0); c.lineTo(W, 0); c.lineTo(W, H * .07); c.quadraticCurveTo(W / 2, H * .095, 0, H * .07); c.closePath(); c.fill();
  for (const v of L.visors) {
    c.fillStyle = grad(c, 0, v.y, 0, v.y + v.h, [[0, '#353a40'], [1, '#26292e']]); rr(c, v.x, v.y, v.w, v.h, 8); c.fill();
    c.strokeStyle = '#41474e'; c.lineWidth = 1; rr(c, v.x, v.y, v.w, v.h, 8); c.stroke();
    c.fillStyle = '#1b1d20'; c.fillRect(v.x + 10, v.y + v.h * .35, 6, v.h * .3); // articulação
  }

  // colunas A e molduras das janelas laterais
  for (const s of [-1, 1]) {
    const px = s < 0 ? W * .155 : W * .845;
    c.fillStyle = grad(c, px - W * .03, 0, px + W * .03, 0, [[0, '#15181b'], [.5, '#30353b'], [1, '#15181b']]);
    c.beginPath();
    c.moveTo(px - s * W * .012, 0); c.lineTo(px + s * W * .022, 0);
    c.lineTo(px + s * W * .05, dt + H * .02); c.lineTo(px + s * W * .005, dt + H * .02);
    c.closePath(); c.fill();
    // porta (parte inferior da janela lateral)
    const ex = s < 0 ? 0 : W;
    c.fillStyle = grad(c, 0, H * .7, 0, H, [[0, '#2b2f34'], [1, '#121416']]);
    c.beginPath(); c.moveTo(ex, H * (truck ? .74 : .72)); c.lineTo(px + s * W * .045, dt + H * .03); c.lineTo(px + s * W * .045, H); c.lineTo(ex, H); c.closePath(); c.fill();
    c.strokeStyle = '#41474e'; c.lineWidth = 2; c.beginPath(); c.moveTo(ex, H * (truck ? .74 : .72)); c.lineTo(px + s * W * .045, dt + H * .03); c.stroke();
  }

  // painel
  const binL = L.cluster.x - W * .02, binR = L.cluster.x + L.cluster.w + W * .02;
  c.fillStyle = grad(c, 0, dt - H * .05, 0, H, [[0, '#3a3f45'], [.08, '#24282c'], [1, '#0e1012']]);
  c.beginPath();
  c.moveTo(0, H); c.lineTo(0, dt + H * .14);
  c.lineTo(W * .14, dt + H * .02);
  c.quadraticCurveTo(W * .2, dt - H * .005, binL, dt);
  c.quadraticCurveTo(binL + W * .02, dt - H * .065, (binL + binR) / 2, dt - H * .07);
  c.quadraticCurveTo(binR - W * .02, dt - H * .065, binR, dt);
  c.quadraticCurveTo(W * .8, dt - H * .005, W * .86, dt + H * .02);
  c.lineTo(W, dt + H * .14); c.lineTo(W, H); c.closePath(); c.fill();
  // brilho na borda superior do painel
  c.strokeStyle = 'rgba(160,175,190,.22)'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(W * .14, dt + H * .02); c.quadraticCurveTo(W * .2, dt - H * .005, binL, dt); c.quadraticCurveTo(binL + W * .02, dt - H * .065, (binL + binR) / 2, dt - H * .07); c.quadraticCurveTo(binR - W * .02, dt - H * .065, binR, dt); c.quadraticCurveTo(W * .8, dt - H * .005, W * .86, dt + H * .02); c.stroke();
  // textura granulada do plástico
  for (let i = 0; i < 2400; i++) { c.fillStyle = `rgba(255,255,255,${Math.random() * .025})`; c.fillRect(Math.random() * W, dt + Math.random() * (H - dt), 1, 1); }

  // saídas de ar
  const vent = (x, y, w, h) => {
    c.fillStyle = '#0b0c0e'; rr(c, x, y, w, h, 8); c.fill();
    c.strokeStyle = '#3b4148'; c.lineWidth = 1.5; rr(c, x, y, w, h, 8); c.stroke();
    for (let k = 1; k < 6; k++) { c.fillStyle = '#2a2f35'; c.fillRect(x + 4, y + k * h / 6 - 1.5, w - 8, 3); }
  };
  if (!L.narrow) { vent(W * .175, dt + H * .07, W * .07, H * .14); vent(W * .634, dt + H * .05, W * .03, H * .1); }

  // molduras do quadro de instrumentos e da central multimídia
  const k = L.cluster;
  c.fillStyle = '#050607'; rr(c, k.x - 6, k.y - 6, k.w + 12, k.h + 12, 18); c.fill();
  c.strokeStyle = '#3a4047'; c.lineWidth = 1.5; rr(c, k.x - 6, k.y - 6, k.w + 12, k.h + 12, 18); c.stroke();
  if (L.screen) {
    const s = L.screen;
    c.fillStyle = '#060708'; rr(c, s.x - 7, s.y - 7, s.w + 14, s.h + 14, 14); c.fill();
    c.strokeStyle = '#444b53'; rr(c, s.x - 7, s.y - 7, s.w + 14, s.h + 14, 14); c.stroke();
  }

  // carcaças dos retrovisores
  for (const [key, m] of Object.entries(L.mirrors)) {
    const pad = key === 'center' ? 7 : 8;
    if (key !== 'center') {
      const side = key.endsWith('L') || key === 'left' ? -1 : 1;
      const ax = side < 0 ? m.x + m.w + pad - 2 : m.x - pad + 2, ay = m.y + m.h * .55;
      c.strokeStyle = '#1a1c1f'; c.lineWidth = 7; c.beginPath(); c.moveTo(ax, ay); c.lineTo(side < 0 ? W * .16 : W * .84, ay + H * .04); c.stroke();
    } else {
      c.fillStyle = '#1b1d20'; c.fillRect(m.x + m.w / 2 - 6, 0, 12, m.y + 4);
    }
    c.fillStyle = grad(c, m.x, m.y, m.x + m.w, m.y + m.h, [[0, '#2c3035'], [1, '#121416']]);
    rr(c, m.x - pad, m.y - pad, m.w + pad * 2, m.h + pad * 2, key === 'center' ? 14 : 12); c.fill();
    c.strokeStyle = '#4a5058'; c.lineWidth = 1.2; rr(c, m.x - pad, m.y - pad, m.w + pad * 2, m.h + pad * 2, key === 'center' ? 14 : 12); c.stroke();
    // furo transparente para o vidro
    c.save(); c.globalCompositeOperation = 'destination-out'; rr(c, m.x, m.y, m.w, m.h, key === 'center' ? 9 : 7); c.fill(); c.restore();
  }

  drawDmsCamera(c, L);

  // camada sobreposta: volante
  [over, c] = layer();
  const w = L.wheel;
  c.save();
  c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 24; c.shadowOffsetY = 8;
  c.lineWidth = w.t; c.strokeStyle = '#141517';
  c.beginPath(); c.arc(w.cx, w.cy, w.r, Math.PI, 2 * Math.PI); c.stroke();
  c.restore();
  // relevo e costura do aro
  c.lineWidth = w.t * .55; c.strokeStyle = grad(c, 0, w.cy - w.r - w.t, 0, w.cy - w.r + w.t, [[0, '#3a3d42'], [1, '#141517']]);
  c.beginPath(); c.arc(w.cx, w.cy, w.r + w.t * .1, Math.PI * 1.02, Math.PI * 1.98); c.stroke();
  c.setLineDash([3, 5]); c.lineWidth = 1; c.strokeStyle = 'rgba(160,160,160,.35)';
  c.beginPath(); c.arc(w.cx, w.cy, w.r - w.t * .28, Math.PI * 1.05, Math.PI * 1.95); c.stroke(); c.setLineDash([]);
  // raios e cubo
  const hubR = w.r * .26;
  for (const s of [-1, 1]) {
    c.fillStyle = grad(c, 0, w.cy - w.r * .35, 0, w.cy, [[0, '#2a2d31'], [1, '#111214']]);
    c.beginPath();
    const a0 = s < 0 ? Math.PI + .14 : -.14;
    const ox = w.cx + Math.cos(a0) * (w.r - w.t * .3), oy = w.cy + Math.sin(a0) * (w.r - w.t * .3);
    c.moveTo(w.cx + s * hubR * .6, w.cy - hubR * .9);
    c.lineTo(ox, oy - w.t * .9);
    c.lineTo(ox, oy + w.t * 1.2);
    c.lineTo(w.cx + s * hubR * .7, w.cy - hubR * .1);
    c.closePath(); c.fill();
    // botões no raio
    c.fillStyle = '#3a3f45'; rr(c, w.cx + s * hubR * 1.35 - (s < 0 ? hubR * .55 : 0), w.cy - hubR * 1.02, hubR * .55, hubR * .32, 4); c.fill();
  }
  c.fillStyle = grad(c, 0, w.cy - hubR * 1.3, 0, w.cy, [[0, '#2d3136'], [1, '#121315']]);
  c.beginPath(); c.ellipse(w.cx, w.cy - hubR * .3, hubR * 1.15, hubR * 1.05, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#43484f'; c.lineWidth = 1.5; c.stroke();
  if (emblem.complete && emblem.naturalWidth) {
    // só o "V" metálico, aplicado direto no cubo, como parte do volante
    const ew = hubR * 1.05, eh = ew * emblem.naturalHeight / emblem.naturalWidth;
    c.save();
    c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = ew * .05; c.shadowOffsetY = ew * .025;
    c.drawImage(emblem, w.cx - ew / 2, w.cy - hubR * .6 - eh / 2, ew, eh);
    c.restore();
  }
}

/* ---------- câmera de monitoramento do motorista (DMS) ----------
 * Representa onde a câmera fica na prática: presa ao quebra-sol do motorista,
 * de frente para o rosto dele. */
function dmsRect(L) {
  const v = L.visors[0], w = clamp(W * .05, 34, 64), h = w * .52;
  return { x: v.x + v.w * .6 - w / 2, y: v.y + v.h + 9, w, h };
}
function drawDmsCamera(c, L) {
  const d = dmsRect(L), v = L.visors[0];
  // presilha pendurando a câmera na borda do quebra-sol
  c.fillStyle = '#16181b';
  rr(c, d.x + d.w / 2 - d.w * .16, v.y + v.h - 4, d.w * .32, d.y - (v.y + v.h) + d.h * .4, 3); c.fill();
  c.fillStyle = '#3a3f45'; c.fillRect(d.x + d.w / 2 - d.w * .2, v.y + v.h - 3, d.w * .4, 3);
  // carcaça levemente voltada para o motorista
  c.save(); c.translate(d.x + d.w / 2, d.y + d.h / 2); c.rotate(.06);
  c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 8; c.shadowOffsetY = 3;
  c.fillStyle = grad(c, 0, -d.h / 2, 0, d.h / 2, [[0, '#2e3238'], [.5, '#17191c'], [1, '#0b0c0e']]);
  rr(c, -d.w / 2, -d.h / 2, d.w, d.h, d.h * .35); c.fill(); c.shadowBlur = 0; c.shadowOffsetY = 0;
  c.strokeStyle = '#4a5058'; c.lineWidth = 1; rr(c, -d.w / 2, -d.h / 2, d.w, d.h, d.h * .35); c.stroke();
  // lente central com reflexo
  const lr = d.h * .3;
  c.fillStyle = '#050608'; c.beginPath(); c.arc(0, 0, lr * 1.25, 0, 7); c.fill();
  const lg = c.createRadialGradient(-lr * .3, -lr * .3, lr * .1, 0, 0, lr);
  lg.addColorStop(0, '#6aa7ff'); lg.addColorStop(.35, '#1b2f6e'); lg.addColorStop(1, '#05070c');
  c.fillStyle = lg; c.beginPath(); c.arc(0, 0, lr, 0, 7); c.fill();
  c.fillStyle = 'rgba(255,255,255,.55)'; c.beginPath(); c.arc(-lr * .35, -lr * .35, lr * .18, 0, 7); c.fill();
  // LEDs infravermelhos (visão noturna) dos dois lados
  for (const sx of [-1, 1]) for (const k of [0, 1]) {
    c.fillStyle = '#2a0f12'; c.beginPath(); c.arc(sx * (lr * 1.9 + k * d.h * .2), 0, d.h * .07, 0, 7); c.fill();
  }
  c.restore();
}
function drawDmsStatus(L, t) {
  const d = dmsRect(L), lvl = V.effectiveLevel(), c = ctx;
  const color = { normal: '#2fe08f', attention: '#ffc44d', critical: '#ff5a4f', intervention: '#ff3b3b', degraded: '#ffb36b' }[lvl];
  const on = lvl === 'normal' || Math.floor(t / 350) % 2 === 0;
  c.save(); c.translate(d.x + d.w / 2, d.y + d.h / 2); c.rotate(.06);
  // LED de status
  c.fillStyle = on ? color : '#1d2a22'; c.shadowColor = color; c.shadowBlur = on ? 8 : 0;
  c.beginPath(); c.arc(d.w * .38, -d.h * .22, Math.max(1.6, d.h * .06), 0, 7); c.fill(); c.shadowBlur = 0;
  // brilho dos LEDs infravermelhos à noite (iluminam o rosto no escuro)
  if (env.night > .2) {
    const lr = d.h * .3;
    for (const sx of [-1, 1]) for (const k of [0, 1]) {
      c.fillStyle = `rgba(255,60,70,${env.night * .55})`; c.shadowColor = '#ff3b4a'; c.shadowBlur = 5;
      c.beginPath(); c.arc(sx * (lr * 1.9 + k * d.h * .2), 0, d.h * .06, 0, 7); c.fill();
    }
    c.shadowBlur = 0;
  }
  c.restore();
  // etiqueta
  if (!L.narrow) {
    const label = 'CÂMERA VIGIA · IA', fs = clamp(W * .0075, 8, 10.5);
    c.font = `800 ${fs}px Inter, "Segoe UI", system-ui, sans-serif`;
    const tw = c.measureText(label).width + fs * 1.8, lx = d.x + d.w / 2 - tw / 2, ly = d.y + d.h + 7;
    c.fillStyle = 'rgba(4,12,24,.78)'; rr(c, lx, ly, tw, fs * 1.9, fs); c.fill();
    c.strokeStyle = color + '99'; c.lineWidth = 1; rr(c, lx, ly, tw, fs * 1.9, fs); c.stroke();
    c.fillStyle = color; c.beginPath(); c.arc(lx + fs * .8, ly + fs * .95, fs * .28, 0, 7); c.fill();
    txt(c, label, lx + fs * 1.3, ly + fs * 1.3, fs, '#e6f2fb', 800);
  }
}

/* ---------- elementos dinâmicos ---------- */
const LEVEL_UI = {
  normal: { color: '#2fe08f', title: 'VIGIA ATIVO', sub: 'Motorista atento', icon: 'vigia' },
  attention: { color: '#ffc44d', title: 'ATENÇÃO', sub: 'Sinais de fadiga', icon: 'coffee' },
  critical: { color: '#ff5a4f', title: 'ALERTA CRÍTICO', sub: 'Confirme atenção', icon: 'blink' },
  intervention: { color: '#ff3b3b', title: 'ALERTA INTERVENÇÃO', sub: 'Possível sonolência', icon: 'warn' },
  degraded: { color: '#ffb36b', title: 'SEM SINAL', sub: 'Modo seguro', icon: 'warn' }
};

function coffee(c, x, y, s, color) {
  c.save(); c.translate(x, y); c.strokeStyle = color; c.fillStyle = color; c.lineWidth = s * .08; c.lineCap = 'round';
  rr(c, -s * .35, -s * .05, s * .6, s * .45, s * .08); c.fill();
  c.beginPath(); c.arc(s * .3, s * .15, s * .13, -Math.PI / 2, Math.PI / 2); c.stroke();
  c.fillRect(-s * .45, s * .43, s * .85, s * .07);
  for (const dx of [-.2, 0, .2]) { c.beginPath(); c.moveTo(dx * s - s * .05, -s * .15); c.bezierCurveTo(dx * s + s * .08, -s * .25, dx * s - s * .12, -s * .35, dx * s, -s * .48); c.stroke(); }
  c.restore();
}
// Símbolo VIGIA (o "V" com a estrada) em vetor, numa única cor.
// Coordenadas tiradas do logotipo (assets/vigia_icon.png), centradas em (630, 632).
function vigiaIcon(c, x, y, s, color) {
  c.save(); c.translate(x, y); c.scale(s / 780, s / 780); c.translate(-630, -632);
  c.fillStyle = color; c.strokeStyle = color; c.lineJoin = 'round';
  c.beginPath(); // traço esquerdo
  c.moveTo(240, 368); c.lineTo(400, 360); c.quadraticCurveTo(440, 362, 462, 398); c.lineTo(560, 575); c.lineTo(455, 750); c.closePath(); c.fill();
  c.beginPath(); // traço direito
  c.moveTo(1015, 370); c.lineTo(855, 360); c.quadraticCurveTo(815, 362, 793, 398); c.lineTo(525, 868); c.quadraticCurveTo(515, 905, 560, 905);
  c.lineTo(665, 905); c.quadraticCurveTo(700, 903, 720, 870); c.closePath(); c.fill();
  c.lineWidth = 18; c.setLineDash([62, 34]); c.lineCap = 'butt'; // faixa tracejada da estrada
  c.beginPath(); c.moveTo(700, 465); c.lineTo(495, 828); c.stroke();
  c.restore();
}
// Indicador de farol: baixo (verde, raios inclinados) ou alto (azul, raios retos).
function headlightIcon(c, x, y, s, high) {
  const color = high ? '#3d8bff' : '#2fe08f';
  c.save(); c.strokeStyle = color; c.fillStyle = color; c.lineWidth = s * .12; c.lineCap = 'round';
  c.shadowColor = color; c.shadowBlur = 6;
  c.beginPath(); c.moveTo(x + s * .1, y - s * .4); c.quadraticCurveTo(x + s * .6, y - s * .4, x + s * .6, y); c.quadraticCurveTo(x + s * .6, y + s * .4, x + s * .1, y + s * .4); c.closePath(); c.stroke();
  for (const k of [-.28, 0, .28]) { c.beginPath(); c.moveTo(x - s * .05, y + k * s); c.lineTo(x - s * .5, y + k * s + (high ? 0 : s * .18)); c.stroke(); }
  c.restore();
}
function warnTri(c, x, y, s, color) {
  c.save(); c.fillStyle = color; c.beginPath(); c.moveTo(x, y - s * .5); c.lineTo(x + s * .5, y + s * .4); c.lineTo(x - s * .5, y + s * .4); c.closePath(); c.fill();
  txt(c, '!', x, y + s * .3, s * .55, '#111', 900, 'center'); c.restore();
}

function drawCluster(L, t) {
  const c = ctx, k = L.cluster, lvl = V.effectiveLevel(), ui = LEVEL_UI[lvl];
  const alertOn = lvl !== 'normal' && lvl !== 'degraded';
  const flash = alertOn && (lvl === 'attention' || Math.floor(t / 450) % 2 === 0);
  c.save();
  rr(c, k.x, k.y, k.w, k.h, 14); c.clip();
  c.fillStyle = grad(c, 0, k.y, 0, k.y + k.h, [[0, '#07121f'], [1, '#02060c']]); c.fillRect(k.x, k.y, k.w, k.h);
  const S = k.h / 170; // escala tipográfica

  // velocímetro
  const r = Math.min(k.h * .4, k.w * .2), cx = k.x + r + k.w * .07, cy = k.y + k.h * .47;
  const max = V.VEHICLES[state.vehicle].maxSpeed, a0 = Math.PI * .75, a1 = Math.PI * 2.25;
  c.lineCap = 'round';
  c.lineWidth = r * .1; c.strokeStyle = '#13283c'; c.beginPath(); c.arc(cx, cy, r, a0, a1); c.stroke();
  const frac = clamp(state.speed / max, 0, 1), aNow = a0 + (a1 - a0) * frac;
  c.strokeStyle = grad(c, cx - r, cy, cx + r, cy, [[0, '#1d6fff'], [.75, '#36c6ff'], [1, '#f4be75']]);
  c.shadowColor = '#1d8fff'; c.shadowBlur = 10;
  c.beginPath(); c.arc(cx, cy, r, a0, aNow); c.stroke(); c.shadowBlur = 0;
  // escala: traços a cada 10 km/h e números a cada 20
  for (let v = 0; v <= max; v += 10) {
    const a = a0 + (a1 - a0) * v / max, major = v % 20 === 0, r0 = r * (major ? .8 : .86);
    c.strokeStyle = v > max * .78 ? '#d98a74' : major ? '#cfe2f1' : '#4f6b84'; c.lineWidth = major ? 1.8 : 1;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r * .93, cy + Math.sin(a) * r * .93); c.stroke();
    if (major) txt(c, String(v), cx + Math.cos(a) * r * .66, cy + Math.sin(a) * r * .66, 8 * S, '#8fb3cc', 600, 'center', 'middle');
  }
  // ponteiro
  c.save(); c.translate(cx, cy); c.rotate(aNow);
  c.shadowColor = '#ff6a3d'; c.shadowBlur = 8; c.fillStyle = '#ff6a3d';
  c.beginPath(); c.moveTo(-r * .12, -2.2 * S); c.lineTo(r * .9, 0); c.lineTo(-r * .12, 2.2 * S); c.closePath(); c.fill();
  c.restore();
  c.fillStyle = '#1b2a3a'; c.beginPath(); c.arc(cx, cy, r * .13, 0, 7); c.fill();
  c.strokeStyle = '#36c6ff'; c.lineWidth = 1.5; c.stroke();
  txt(c, String(Math.round(state.speed)), cx, cy + r * .42, 24 * S, '#ffffff', 800, 'center', 'middle');
  txt(c, 'km/h', cx, cy + r * .66, 8 * S, '#9cc0d8', 600, 'center', 'middle');
  rr(c, cx - r * .62, k.y + k.h - 24 * S, r * 1.24, 16 * S, 5); c.fillStyle = '#0c1a29'; c.fill();
  txt(c, world.odometer.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' km', cx, k.y + k.h - 16 * S, 8.5 * S, '#cfe2f1', 600, 'center', 'middle');

  // farol aceso (sempre; alto à noite)
  headlightIcon(c, k.x + 18 * S, k.y + 17 * S, 15 * S, env.night > .15);

  // coluna central: marcha, hora, temperatura, ADAS
  const mx = cx + r + k.w * .05, mw = k.w * .62 - (mx - k.x);
  txt(c, world.gear, mx + mw / 2 - 4 * S, k.y + 20 * S, 16 * S, '#3aa7ff', 800, 'right');
  txt(c, String(world.gearNum || ''), mx + mw / 2, k.y + 20 * S, 9 * S, '#9cc0d8', 700, 'left');
  txt(c, V.clockText() + ' · ' + env.temperature + '°C', mx + mw / 2, k.y + 33 * S, 8.5 * S, '#cfe2f1', 600, 'center');
  // visão de faixa (ADAS)
  const lx = mx, ly = k.y + 42 * S, lw = mw, lh = k.h - 50 * S;
  // pisca-alerta: setas nos cantos superiores da área da faixa, abaixo dos textos e dentro do quadro
  if (state.hazardOn) {
    const as = 8 * S, ay = ly + as * .9;
    c.save(); c.fillStyle = '#2fe08f'; c.shadowColor = '#2fe08f'; c.shadowBlur = 8;
    for (const s of [-1, 1]) {
      const tip = s < 0 ? lx + 1 : lx + lw - 1; // ponta da seta junto à borda da coluna
      c.beginPath(); c.moveTo(tip, ay); c.lineTo(tip - s * as, ay - as * .62); c.lineTo(tip - s * as, ay - as * .25);
      c.lineTo(tip - s * as * 1.6, ay - as * .25); c.lineTo(tip - s * as * 1.6, ay + as * .25); c.lineTo(tip - s * as, ay + as * .25);
      c.lineTo(tip - s * as, ay + as * .62); c.closePath(); c.fill();
    }
    c.restore();
  }
  c.strokeStyle = state.hazardOn ? '#ffb02e' : '#1ee39a'; c.lineWidth = 3 * S; c.shadowColor = c.strokeStyle; c.shadowBlur = 8;
  for (const s of [-1, 1]) { c.beginPath(); c.moveTo(lx + lw / 2 + s * lw * .1, ly); c.lineTo(lx + lw / 2 + s * lw * .42, ly + lh); c.stroke(); }
  c.shadowBlur = 0;
  // veículo à frente
  if (world.lead) {
    const f = clamp(1 - world.lead.z / 120, 0, 1);
    const vw = lw * (.12 + f * .1), vy = ly + lh * (.05 + f * .3);
    c.fillStyle = '#7f95a8'; rr(c, lx + lw / 2 - vw / 2, vy, vw, vw * .55, 3); c.fill();
  }
  // ego
  const ew = lw * .3, eh = lh * .45;
  c.fillStyle = grad(c, 0, ly + lh - eh, 0, ly + lh, [[0, '#c9d8e6'], [1, '#6f8396']]);
  if (L.truck) { rr(c, lx + lw / 2 - ew / 2, ly + lh - eh, ew, eh, 4); c.fill(); c.fillStyle = '#2d6fb5'; rr(c, lx + lw / 2 - ew / 2, ly + lh - eh * .3, ew, eh * .3, 3); c.fill(); }
  else { rr(c, lx + lw / 2 - ew / 2, ly + lh - eh * .7, ew, eh * .7, 7); c.fill(); c.fillStyle = '#1a2836'; rr(c, lx + lw / 2 - ew * .36, ly + lh - eh * .6, ew * .72, eh * .22, 3); c.fill(); }

  // painel de alerta à direita
  const px = k.x + k.w * .64, pw = k.w * .34, py = k.y + 8 * S, ph = k.h - 16 * S;
  c.fillStyle = alertOn ? (flash ? 'rgba(120,10,10,.55)' : 'rgba(60,8,8,.45)') : 'rgba(10,30,24,.5)';
  rr(c, px, py, pw, ph, 12); c.fill();
  c.strokeStyle = ui.color; c.lineWidth = alertOn ? 2.4 : 1.3; c.shadowColor = ui.color; c.shadowBlur = alertOn && flash ? 18 : 6;
  rr(c, px, py, pw, ph, 12); c.stroke(); c.shadowBlur = 0;
  const icx = px + pw / 2, icy = py + ph * .26, is = Math.min(pw, ph) * .32;
  // crítico: alterna entre o triângulo de atenção e a xícara de café
  // intervenção: o triângulo pisca (aceso/apagado) no ritmo do painel
  let icon = ui.icon === 'blink' ? (Math.floor(t / 700) % 2 ? 'coffee' : 'warn') : ui.icon;
  if (lvl === 'intervention' && !flash) icon = null;
  if (icon === 'coffee') coffee(c, icx, icy, is, ui.color);
  else if (icon === 'vigia') vigiaIcon(c, icx, icy, is * 1.15, ui.color);
  else if (icon === 'warn') warnTri(c, icx, icy, is, ui.color);
  const words = ui.title.split(' ');
  if (words.length > 1 && pw < 140) {
    txt(c, words[0], icx, py + ph * .55, 10 * S, ui.color, 900, 'center');
    txt(c, words.slice(1).join(' '), icx, py + ph * .55 + 12 * S, 10 * S, ui.color, 900, 'center');
  } else txt(c, ui.title, icx, py + ph * .6, 10 * S, ui.color, 900, 'center');
  if (alertOn) txt(c, 'AVISO ATIVADO', icx, py + ph * .78, 7.5 * S, '#f3d2d2', 700, 'center');
  txt(c, ui.sub, icx, py + ph * (alertOn ? .88 : .8), 7.5 * S, '#c5d4df', 600, 'center');
  c.restore();
}

function drawScreen(L) {
  const s = L.screen; if (!s) return;
  const c = ctx, S = s.h / 165;
  c.save();
  rr(c, s.x, s.y, s.w, s.h, 10); c.clip();
  c.fillStyle = grad(c, 0, s.y, 0, s.y + s.h, [[0, '#0d1b2c'], [1, '#07101b']]); c.fillRect(s.x, s.y, s.w, s.h);
  txt(c, 'VISÃO 2D - SIMPLIFICADA', s.x + 10 * S, s.y + 15 * S, 8.5 * S, '#cfe2f1', 700);
  // a mesma cena da "Visão 2D", renderizada em tamanho reduzido (quadros alternados)
  const mx = s.x + 6 * S, my = s.y + 21 * S, mw = s.w - 12 * S, mh = s.h - 21 * S - 24 * S;
  // a mesma cena da Visão 2D, redesenhada a cada quadro (antes era a cada 2, parecia travar)
  const mini = V.scene2d?.renderMini(Math.round(mw), Math.round(mh)) || cabin.miniCache;
  if (mini) { cabin.miniCache = mini; c.save(); rr(c, mx, my, mw, mh, 6); c.clip(); c.drawImage(mini, mx, my, mw, mh); c.restore(); }
  c.strokeStyle = '#21405e'; c.lineWidth = 1; rr(c, mx, my, mw, mh, 6); c.stroke();
  // barra de status
  const lvl = V.effectiveLevel(), ui = LEVEL_UI[lvl], by = s.y + s.h - 12 * S;
  txt(c, Math.round(state.speed) + ' km/h', mx + 2 * S, by + 3 * S, 10 * S, '#ffffff', 800);
  const dist = world.lead ? Math.max(0, Math.round(world.lead.z - world.lead.len / 2)) + ' m à frente' : '';
  if (s.w > 250) txt(c, dist, s.x + s.w / 2, by + 3 * S, 8.5 * S, '#9cc0d8', 600, 'center'); // só se couber
  c.font = `800 ${9 * S}px Inter, "Segoe UI", system-ui, sans-serif`;
  c.fillStyle = ui.color; c.beginPath(); c.arc(s.x + s.w - 8 * S - c.measureText(V.LABEL[lvl]).width - 9 * S, by, 4 * S, 0, 7); c.fill();
  txt(c, V.LABEL[lvl], s.x + s.w - 8 * S, by + 3 * S, 9 * S, ui.color, 800, 'right');
  c.restore();
}

function draw(dt, t) {
  if (state.viewMode !== '3d' || !under || !V.world3d?.ready) return;
  const L = cabin.layout, dy = V.motion.bob; // balanço vertical da cabine (suspensão)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(under, 0, dy * dpr);
  // o deslocamento abre uma faixa na borda oposta: completa com o teto (em cima) ou o painel (embaixo)
  const gap = Math.ceil(Math.abs(dy) * dpr) + 1;
  if (dy > 0) { ctx.fillStyle = '#1b1e22'; ctx.fillRect(0, 0, canvas.width, gap); }
  // embaixo sempre fecha ao menos 2px (altura fracionária deixa a última linha semitransparente)
  const bottom = dy < 0 ? gap : 2;
  ctx.fillStyle = '#0e1012'; ctx.fillRect(0, canvas.height - bottom, canvas.width, bottom);
  ctx.setTransform(dpr, 0, 0, dpr, 0, dy * dpr);
  drawCluster(L, t);
  drawScreen(L);
  // reflexo noturno do painel no para-brisa
  if (env.night > .3) {
    ctx.globalAlpha = (env.night - .3) * .18;
    ctx.fillStyle = '#2aa0ff';
    ctx.beginPath(); ctx.ellipse(L.cluster.x + L.cluster.w / 2, L.dashTop - H * .06, L.cluster.w * .45, H * .03, 0, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }
  drawDmsStatus(L, t);
  // volante: leves correções para os lados, girando em torno do próprio centro
  const w = L.wheel;
  ctx.setTransform(1, 0, 0, 1, 0, dy * dpr);
  ctx.translate(w.cx * dpr, w.cy * dpr); ctx.rotate(V.motion.steer * Math.PI / 180); ctx.translate(-w.cx * dpr, -w.cy * dpr);
  ctx.drawImage(over, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
V.addRenderer(draw);
})();
