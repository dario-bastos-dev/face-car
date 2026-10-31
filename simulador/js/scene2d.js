/* VIGIA v0.6 — visão superior 2D (Canvas).
 * Mesmo mundo da cabine 3D (distâncias em metros, tráfego, placas, ciclo dia/noite).
 * Escalas separadas: a pista é larga na tela (lateral em fração da largura) e os
 * veículos/distâncias usam pixels por metro no eixo longitudinal. */
(() => {
'use strict';
const V = window.VIGIA;
const { state, world, env, clamp } = V;

let canvas, ctx, W = 0, H = 0, dpr = 1;
let ppm = 16;        // pixels por metro (longitudinal e tamanho dos veículos)
let lane = 150;      // largura de uma faixa em pixels
let CX = 0;          // eixo da via
const VSCALE = V.DISPLAY_SCALE; // mesma ampliação usada nos espaçamentos do núcleo // veículos levemente ampliados para leitura
let grassPat, asphaltPat, gravelPat, forestPat, darkLayer, darkCtx;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function hash(n) { const s = Math.sin(n * 91.7) * 43758.5453; return s - Math.floor(s); }
function rr(c, x, y, w, h, r) { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); }
function tile(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c; }
function noise(c, w, h, base, spread, seed) {
  const img = c.createImageData(w, h), d = img.data, r = rng(seed);
  for (let i = 0; i < d.length; i += 4) { const n = (r() - .5) * spread; d[i] = base[0] + n; d[i + 1] = base[1] + n; d[i + 2] = base[2] + n * .9; d[i + 3] = 255; }
  c.putImageData(img, 0, 0);
}
function blob(c, x, y, r, base, k, lobes = 7) {
  const g = c.createRadialGradient(x - r * .35, y - r * .35, r * .1, x, y, r * 1.05);
  g.addColorStop(0, `rgb(${base[0] + 45},${base[1] + 50},${base[2] + 22})`);
  g.addColorStop(.65, `rgb(${base[0]},${base[1]},${base[2]})`);
  g.addColorStop(1, `rgb(${base[0] - 22},${base[1] - 28},${base[2] - 14})`);
  c.fillStyle = g; c.beginPath();
  for (let i = 0; i <= lobes; i++) {
    const a = i / lobes * Math.PI * 2, rr2 = r * (.84 + hash(k + i * 1.7) * .22);
    const px = x + Math.cos(a) * rr2, py = y + Math.sin(a) * rr2;
    if (i) c.quadraticCurveTo(x + Math.cos(a - Math.PI / lobes) * r * 1.13, y + Math.sin(a - Math.PI / lobes) * r * 1.13, px, py); else c.moveTo(px, py);
  }
  c.fill();
}
const GREENS = [[46, 84, 36], [60, 100, 44], [40, 74, 34], [74, 108, 48], [52, 92, 40]];

// Copas pré-desenhadas (cor × formato), reaproveitadas a cada quadro.
const sprites = [];
function treeSprite(color, shape) {
  const key = color * 4 + shape;
  if (!sprites[key]) sprites[key] = tile(64, 64, c => blob(c, 32, 32, 27, GREENS[color], shape * 7.3 + color, 6));
  return sprites[key];
}
function buildPatterns() {
  const g = tile(256, 256, (c, w, h) => {
    noise(c, w, h, [72, 96, 46], 30, 3);
    const r = rng(8);
    for (let i = 0; i < 40; i++) { c.fillStyle = r() < .5 ? `rgba(120,130,60,${.1 + r() * .12})` : `rgba(30,55,24,${.12 + r() * .15})`; c.beginPath(); c.arc(r() * w, r() * h, 6 + r() * 30, 0, 7); c.fill(); }
  });
  const a = tile(256, 256, (c, w, h) => {
    noise(c, w, h, [50, 52, 55], 26, 5);
    const r = rng(9);
    for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(${r() < .5 ? 15 : 120},${r() < .5 ? 16 : 120},${r() < .5 ? 18 : 124},${.06 + r() * .1})`; c.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2); }
  });
  const s = tile(128, 128, (c, w, h) => {
    noise(c, w, h, [104, 100, 92], 60, 11);
    const r = rng(12);
    for (let i = 0; i < 220; i++) { c.fillStyle = `rgba(${40 + r() * 140},${40 + r() * 130},${35 + r() * 110},.6)`; c.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3); }
  });
  // floresta: copas densas sobrepostas
  const f = tile(512, 512, (c, w, h) => {
    c.fillStyle = '#1f3a1c'; c.fillRect(0, 0, w, h);
    const r = rng(21);
    for (let i = 0; i < 420; i++) {
      const x = r() * w, y = r() * h, rad = 14 + r() * 30, b = GREENS[Math.floor(r() * GREENS.length)];
      for (const [dx, dy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) {
        c.fillStyle = 'rgba(8,20,8,.35)'; c.beginPath(); c.arc(x + dx + 5, y + dy + 6, rad, 0, 7); c.fill();
        blob(c, x + dx, y + dy, rad, b, i * 3.1);
      }
    }
  });
  grassPat = ctx.createPattern(g, 'repeat');
  asphaltPat = ctx.createPattern(a, 'repeat');
  gravelPat = ctx.createPattern(s, 'repeat');
  forestPat = ctx.createPattern(f, 'repeat');
}

function resize() {
  const box = canvas.parentElement;
  W = box.clientWidth; H = box.clientHeight;
  if (!W || !H) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  darkLayer.width = canvas.width; darkLayer.height = canvas.height;
  const narrow = W < 720;
  // Desktop: pista no centro, entre os painéis laterais (como na referência).
  CX = narrow ? W * .5 : W * .505;
  lane = narrow ? W * .25 : clamp(W * .15, 110, 260);
  ppm = clamp(H / 62, 6, 18);
  if (!grassPat) buildPatterns();
}

// lateral em "faixas" (0 = eixo, ±1 = bordas da pista)
function lx(f) { return CX + f * lane; }
function sy(z) { return H * .66 - z * ppm; }
const EDGE = 1.02, GRAVEL = 1.14, RAIL = 1.52;

function drawGround(scroll) {
  const c = ctx;
  // floresta ao fundo
  c.save(); c.translate(0, scroll % 512); c.fillStyle = forestPat; c.fillRect(0, -512, W, H + 1024); c.restore();
  // faixa de vegetação baixa entre a pista e o guard-rail
  for (const s of [-1, 1]) {
    const a = lx(s * GRAVEL), b = lx(s * (RAIL + .05));
    c.save(); c.translate(0, scroll % 256); c.fillStyle = grassPat; c.fillRect(Math.min(a, b), -256, Math.abs(b - a), H + 512); c.restore();
    c.save(); c.translate(0, scroll % 128); c.fillStyle = gravelPat;
    const g0 = lx(s * EDGE), g1 = lx(s * GRAVEL);
    c.fillRect(Math.min(g0, g1), -128, Math.abs(g1 - g0), H + 256); c.restore();
  }
  // asfalto
  c.save(); c.translate(0, scroll % 256); c.fillStyle = asphaltPat; c.fillRect(lx(-EDGE), -256, lx(EDGE) - lx(-EDGE), H + 512); c.restore();
  // trilhas de pneus
  for (const f of [-.72, -.28, .28, .72]) {
    const x = lx(f), w = lane * .2;
    const g = c.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, 'rgba(10,11,13,0)'); g.addColorStop(.5, 'rgba(10,11,13,.22)'); g.addColorStop(1, 'rgba(10,11,13,0)');
    c.fillStyle = g; c.fillRect(x - w, 0, w * 2, H);
  }
  // linhas de bordo (brancas, contínuas)
  const lw = Math.max(3, lane * .045);
  c.fillStyle = '#d9dcdc';
  for (const s of [-1, 1]) c.fillRect(lx(s * .97) - lw / 2, 0, lw, H);
  // linha central amarela tracejada
  const dash = 5.5 * ppm, gap = 4.5 * ppm, period = dash + gap, off = scroll % period;
  c.fillStyle = '#e8b52e'; c.shadowColor = 'rgba(232,181,46,.35)'; c.shadowBlur = 6;
  for (let y = -period + off; y < H; y += period) c.fillRect(CX - lw * .55, y, lw * 1.1, dash);
  c.shadowBlur = 0;
  // guard-rail com postes
  for (const s of [-1, 1]) {
    const x = lx(s * RAIL);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(x + s * 3 - 2, 0, 4, H);
    const g = c.createLinearGradient(x - 3, 0, x + 3, 0); g.addColorStop(0, '#7d848b'); g.addColorStop(.5, '#d3d8dc'); g.addColorStop(1, '#7d848b');
    c.fillStyle = g; c.fillRect(x - 3, 0, 6, H);
    const step = 6 * ppm, o = scroll % step;
    c.fillStyle = '#5c6268';
    for (let y = -step + o; y < H; y += step) c.fillRect(x - 4, y, 8, 5);
  }
}

// arbustos e árvores na faixa de vegetação (determinísticos pela distância)
function drawVegetation() {
  const c = ctx, seg = 3.4;
  const zMin = (sy(0) - H) / ppm - 6, zMax = sy(0) / ppm + 6;
  const d0 = Math.floor((world.distance + zMin) / seg), d1 = Math.ceil((world.distance + zMax) / seg);
  const items = [];
  for (let i = d0; i <= d1; i++) {
    for (const s of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const h = hash(i * 7.3 + k * 1.37 + (s > 0 ? 50 : 0));
        if (h < .25) continue;
        const f = GRAVEL + .06 + hash(i * 3.1 + k + s) * (RAIL - GRAVEL - .1);
        const z = i * seg + hash(i + k * 9.1 + s) * seg - world.distance;
        const r = lane * (.05 + hash(i * 1.9 + k * 4.4 + s) * .07);
        items.push({ x: lx(s * f), y: sy(z), r, sprite: treeSprite(Math.floor(hash(i * 2.7 + k) * GREENS.length), (i * 13 + k) % 4) });
      }
    }
  }
  c.fillStyle = 'rgba(5,15,5,.35)';
  for (const t of items) { c.beginPath(); c.arc(t.x + t.r * .35, t.y + t.r * .45, t.r, 0, 7); c.fill(); }
  for (const t of items) c.drawImage(t.sprite, t.x - t.r * 1.15, t.y - t.r * 1.15, t.r * 2.3, t.r * 2.3);
}

function drawLaneLabels() {
  const c = ctx, y = Math.max(22, H * .045);
  c.save();
  c.font = `800 ${clamp(lane * .085, 10, 15)}px Inter, "Segoe UI", system-ui, sans-serif`;
  c.textBaseline = 'middle'; c.fillStyle = 'rgba(225,232,238,.82)'; c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 4;
  c.textAlign = 'center';
  const short = lane < 130;
  c.fillText(short ? '↓ OPOSTO' : '↓  SENTIDO OPOSTO', lx(-.5), y);
  c.fillText(short ? 'SEU ↑' : 'SEU SENTIDO  ↑', lx(.5), y);
  c.restore();
}

// Trechos urbanos: calçadas, quadras com prédios, ruas transversais, semáforos, guarda e pedestres.
const ROOFS = ['#7d7a75', '#9a958c', '#a2492e', '#b65a37', '#6f747a', '#c2b8a6', '#8b5a3c', '#5f666e'];
const WALK = 1.55; // borda externa da calçada (em larguras de faixa)
function sideX(x) { // posição lateral do mundo (m) -> tela, comprimindo calçada entre EDGE e WALK
  const s = Math.sign(x), a = Math.abs(x);
  return lx(s * (a <= 6.6 ? a / 3.6 * EDGE / 1.02 : EDGE + (a - 6.6) / 3.5 * (WALK - EDGE)));
}
function drawCity() {
  const c = ctx, d = world.distance;
  const ahead = sy(0) / ppm + 20, behind = (H - sy(0)) / ppm + 20;
  const from = d - behind, to = d + ahead;
  for (const [a, b] of V.cityRanges(from, to)) {
    const top = Math.max(0, sy(b - d)), bot = Math.min(H, sy(a - d));
    if (bot <= top) continue;
    c.save(); c.beginPath(); c.rect(0, top, W, bot - top); c.clip();
    for (const s of [-1, 1]) {
      const xe = lx(s * EDGE), xw = lx(s * WALK), xo = s < 0 ? 0 : W;
      c.fillStyle = '#8f8a80'; c.fillRect(Math.min(xw, xo), top, Math.abs(xo - xw), bot - top);      // quadras
      c.fillStyle = '#b7b3a9'; c.fillRect(Math.min(xe, xw), top, Math.abs(xw - xe), bot - top);      // calçada
      c.fillStyle = '#dcd8cf'; c.fillRect(xe - (s < 0 ? 3 : 0), top, 3, bot - top);                  // meio-fio
      c.fillStyle = 'rgba(0,0,0,.08)';                                                                  // juntas da calçada
      for (let S = Math.ceil(from / 4) * 4; S < to; S += 4) c.fillRect(Math.min(xe, xw), sy(S - d), Math.abs(xw - xe), 1);
    }
    // prédios e casas vistos de cima (lotes de 16 m)
    const seg = 16;
    for (let k = Math.floor(from / seg); k <= Math.ceil(to / seg); k++) {
      const S = k * seg + seg / 2;
      if (S < a - 8 || S > b + 8 || V.nearCrossing(S, 14)) continue;
      for (const s of [-1, 1]) {
        const h = hash(k * 3.7 + (s > 0 ? 11 : 0)), h2 = hash(k * 1.9 + s * 5);
        const x0 = lx(s * (WALK + .08)), w = lane * (.45 + h * .9), len = seg * .82 * ppm;
        const y = sy(S - d) - len / 2, x = s > 0 ? x0 : x0 - w;
        c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(x + 6, y + 6, w, len);
        const roof = ROOFS[Math.floor(h2 * ROOFS.length)];
        c.fillStyle = roof; c.fillRect(x, y, w, len);
        c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(x + 3, y + 3, w - 6, len * .45);
        if (h > .55) { c.fillStyle = 'rgba(40,44,50,.55)'; c.fillRect(x + w * .2, y + len * .25, w * .18, len * .14); c.fillRect(x + w * .55, y + len * .55, w * .14, len * .12); } // casas de máquinas
        if (h < .3 && roof !== '#a2492e') { c.strokeStyle = 'rgba(0,0,0,.18)'; c.beginPath(); c.moveTo(x, y + len / 2); c.lineTo(x + w, y + len / 2); c.stroke(); }
      }
    }
    // cruzamentos
    for (const S of V.crossingsBetween(from, to)) {
      const y = sy(S - d), hh = 9 * ppm;
      c.fillStyle = '#4a4d50';
      c.fillRect(0, y - hh / 2, lx(-EDGE), hh); c.fillRect(lx(EDGE), y - hh / 2, W - lx(EDGE), hh);
      c.fillStyle = '#e8e8e2'; // faixa de pedestres na pista principal
      const yz = sy(S - 7.5 - d);
      for (let i = 0; i < 8; i++) c.fillRect(lx(-EDGE + (i + .25) * EDGE * 2 / 8), yz - 1.5 * ppm, EDGE * 2 / 8 * lane * .5, 3 * ppm);
      // semáforos sempre verdes
      for (const [x, yy] of [[lx(EDGE + .02), sy(S - 9.5 - d)], [lx(-EDGE - .02), sy(S + 9.5 - d)]]) {
        c.fillStyle = '#1a1c1e'; c.fillRect(x - 5, yy - 9, 10, 18);
        c.fillStyle = '#23ff6a'; c.shadowColor = '#23ff6a'; c.shadowBlur = 8; c.beginPath(); c.arc(x, yy + 4, 3, 0, 7); c.fill(); c.shadowBlur = 0;
      }
      // guarda de trânsito na esquina
      const gx = sideX(7.9), gy = sy(S + 5 - d), r = Math.max(3, .32 * ppm * VSCALE);
      c.fillStyle = '#d9ff3a'; c.beginPath(); c.ellipse(gx, gy, r * 1.3, r * .9, 0, 0, 7); c.fill();
      c.fillStyle = '#f4f4f2'; c.beginPath(); c.arc(gx, gy, r * .55, 0, 7); c.fill();
    }
    // pedestres
    for (const p of world.peds) {
      if (!p.active || p.S < a || p.S > b) continue;
      const x = sideX(p.x), y = sy(p.S - d), r = Math.max(2.5, .28 * ppm * VSCALE), step = Math.sin(p.phase) * r * .6;
      c.fillStyle = 'rgba(0,0,0,.25)'; c.beginPath(); c.ellipse(x + 2, y + 2, r * 1.2, r * .8, 0, 0, 7); c.fill();
      c.fillStyle = p.pants; c.fillRect(x - r * .5, y + step - r * .3, r * .4, r * .6); c.fillRect(x + r * .1, y - step - r * .3, r * .4, r * .6);
      c.fillStyle = p.shirt; c.beginPath(); c.ellipse(x, y, r * 1.15, r * .7, 0, 0, 7); c.fill();
      c.fillStyle = '#2a1e16'; c.beginPath(); c.arc(x, y, r * .5, 0, 7); c.fill();
    }
    c.restore();
  }
}

function drawSigns() {
  const c = ctx, zMin = (sy(0) - H) / ppm, zMax = sy(0) / ppm;
  for (const s of V.signsBetween(world.distance + zMin, world.distance + zMax)) {
    if (s.type === 'km') continue;
    const x = lx(GRAVEL + .12), y = sy(s.at - world.distance), sz = clamp(lane * .2, 18, 34);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.ellipse(x + 4, y + 5, sz * .55, sz * .45, 0, 0, 7); c.fill();
    const label = (bg, fg, text) => { // placas de painel vistas de cima: retângulo colorido com a palavra-chave
      c.font = `900 ${sz * .3}px Arial`; const tw = c.measureText(text).width + sz * .5;
      c.fillStyle = bg; rr(c, x - sz * .2, y - sz * .32, tw, sz * .64, 3); c.fill();
      c.fillStyle = fg; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(text, x + sz * .05, y + 1);
    };
    if (s.type === 'animals') {
      c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillStyle = '#111'; c.fillRect(-sz * .38, -sz * .38, sz * .76, sz * .76);
      c.fillStyle = '#f5c400'; c.fillRect(-sz * .33, -sz * .33, sz * .66, sz * .66); c.restore();
      c.fillStyle = '#111'; c.beginPath(); c.ellipse(x + sz * .03, y + sz * .03, sz * .17, sz * .09, 0, 0, 7); c.fill();
      c.beginPath(); c.arc(x - sz * .17, y - sz * .04, sz * .06, 0, 7); c.fill();
    } else if (s.type === 'noPassing') {
      c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, sz / 2, 0, 7); c.fill();
      c.strokeStyle = '#d0141e'; c.lineWidth = sz * .12; c.beginPath(); c.arc(x, y, sz / 2 - sz * .07, 0, 7); c.stroke();
      c.fillStyle = '#d0141e'; c.fillRect(x - sz * .2, y - sz * .1, sz * .14, sz * .22); c.fillStyle = '#111'; c.fillRect(x + sz * .05, y - sz * .1, sz * .14, sz * .22);
      c.strokeStyle = '#d0141e'; c.lineWidth = sz * .08; c.beginPath(); c.moveTo(x - sz * .3, y - sz * .3); c.lineTo(x + sz * .3, y + sz * .3); c.stroke();
    } else if (s.type === 'city') label('#0d6b3a', '#fff', s.value[0][0] + ' ' + s.value[0][1] + ' km');
    else if (s.type === 'rest') label('#1557b0', '#fff', 'PARE E DESCANSE');
    else if (s.type === 'belt') label('#fff', '#111', 'USE O CINTO');
    else if (s.type === 'distance') label('#fff', '#111', 'MANTENHA DISTÂNCIA');
    else if (s.type === 'welcome') label('#1557b0', '#fff', 'BEM-VINDO A ' + s.value);
    else if (s.type === 'busStop') label('#1557b0', '#fff', 'ÔNIBUS');
    else if (s.type === 'pedestrian') {
      c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillStyle = '#111'; c.fillRect(-sz * .38, -sz * .38, sz * .76, sz * .76);
      c.fillStyle = '#f5c400'; c.fillRect(-sz * .33, -sz * .33, sz * .66, sz * .66); c.restore();
      c.fillStyle = '#111'; c.beginPath(); c.arc(x, y - sz * .12, sz * .07, 0, 7); c.fill(); c.fillRect(x - sz * .04, y - sz * .04, sz * .08, sz * .2);
    }
    else if (s.type === 'vigia') {
      c.fillStyle = '#1557b0'; rr(c, x - sz * .2, y - sz * .32, sz * 2, sz * .64, 3); c.fill();
      c.fillStyle = '#fff'; c.font = `900 ${sz * .32}px Arial`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('VIGIA', x + sz * .8, y + 1);
    }
  }
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${clamp((n >> 16) + amt, 0, 255)},${clamp(((n >> 8) & 255) + amt, 0, 255)},${clamp((n & 255) + amt, 0, 255)})`;
}

// Fachos de luz (desenhados antes dos veículos, por cima do asfalto)
function beam(x, y, dir, len, wid, color, alpha) {
  const c = ctx, tip = y + dir * len;
  const g = c.createLinearGradient(0, y, 0, tip);
  g.addColorStop(0, `rgba(${color},${alpha})`); g.addColorStop(.55, `rgba(${color},${alpha * .35})`); g.addColorStop(1, `rgba(${color},0)`);
  c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = g;
  c.beginPath(); c.moveTo(x - wid * .35, y); c.lineTo(x + wid * .35, y); c.lineTo(x + wid * 1.15, tip); c.lineTo(x - wid * 1.15, tip); c.closePath(); c.fill();
  c.restore();
}

/* Veículo visto de cima, frente para cima (o oposto é girado 180°). */
function sedan(c, len, wid, color, van, hatch) {
  const body = c.createLinearGradient(-wid / 2, 0, wid / 2, 0);
  body.addColorStop(0, shade(color, -55)); body.addColorStop(.18, shade(color, 10)); body.addColorStop(.5, shade(color, 45)); body.addColorStop(.82, shade(color, 10)); body.addColorStop(1, shade(color, -55));
  // retrovisores
  c.fillStyle = shade(color, -30);
  for (const s of [-1, 1]) { c.beginPath(); c.ellipse(s * wid * .56, -len * .14, wid * .1, wid * .06, s * .3, 0, 7); c.fill(); }
  // carroceria afinando nas pontas
  c.fillStyle = body; c.beginPath();
  c.moveTo(-wid * .36, -len / 2);
  c.quadraticCurveTo(0, -len / 2 - len * .015, wid * .36, -len / 2);
  c.quadraticCurveTo(wid / 2, -len * .46, wid / 2, -len * .3);
  c.lineTo(wid / 2, len * .36);
  c.quadraticCurveTo(wid / 2, len / 2, wid * .3, len / 2);
  c.lineTo(-wid * .3, len / 2);
  c.quadraticCurveTo(-wid / 2, len / 2, -wid / 2, len * .36);
  c.lineTo(-wid / 2, -len * .3);
  c.quadraticCurveTo(-wid / 2, -len * .46, -wid * .36, -len / 2);
  c.fill();
  // vinco do capô
  c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(-wid * .15, -len * .46); c.lineTo(-wid * .2, -len * .25); c.moveTo(wid * .15, -len * .46); c.lineTo(wid * .2, -len * .25); c.stroke();
  // vidros
  const glass = (y0, y1, inset0, inset1) => {
    const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, '#2b3a49'); g.addColorStop(1, '#0b1118');
    c.fillStyle = g; c.beginPath(); c.moveTo(-wid * inset0, y0); c.lineTo(wid * inset0, y0); c.lineTo(wid * inset1, y1); c.lineTo(-wid * inset1, y1); c.closePath(); c.fill();
  };
  if (van) { glass(-len * .4, -len * .3, .42, .46); }
  else {
    glass(-len * .24, -len * .08, .38, .44); // para-brisa
    if (hatch) glass(len * .3, len * .42, .43, .4); // Gol: vidro traseiro quase na ponta (hatch)
    else glass(len * .24, len * .33, .43, .36);   // vidro traseiro
    // teto e teto solar
    c.fillStyle = shade(color, 20); rr(c, -wid * .42, -len * .08, wid * .84, len * .32, wid * .1); c.fill();
    c.fillStyle = '#121a22'; rr(c, -wid * .26, -len * .02, wid * .52, len * .14, 3); c.fill();
    c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(-wid * .2, -len * .01, wid * .1, len * .12);
    // vidros laterais
    c.fillStyle = '#16202b';
    for (const s of [-1, 1]) c.fillRect(s * wid * .44 - (s > 0 ? wid * .05 : 0), -len * .06, wid * .05, len * .3);
  }
  // reflexo diagonal no para-brisa
  c.fillStyle = 'rgba(255,255,255,.08)'; c.beginPath(); c.moveTo(-wid * .3, -len * .23); c.lineTo(-wid * .1, -len * .23); c.lineTo(-wid * .3, -len * .1); c.closePath(); c.fill();
}
// Caminhonete vista de cima: cabine com vidros e caçamba aberta atrás
function pickup(c, len, wid, color) {
  sedan(c, len, wid, color, false, false);
  const y0 = len * .06, y1 = len / 2 - len * .04;
  c.fillStyle = shade(color, -25); rr(c, -wid * .46, y0, wid * .92, y1 - y0, 3); c.fill();
  c.fillStyle = '#2a2c2f'; rr(c, -wid * .38, y0 + len * .03, wid * .76, y1 - y0 - len * .06, 2); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
  for (let k = 1; k < 4; k++) { const y = y0 + (y1 - y0) * k / 4; c.beginPath(); c.moveTo(-wid * .36, y); c.lineTo(wid * .36, y); c.stroke(); }
}
function truck(c, len, wid, cab, box, cabFrac = .15) {
  const cabL = len * cabFrac;
  c.fillStyle = shade(box, -10); rr(c, -wid / 2, -len / 2 + cabL + len * .015, wid, len - cabL - len * .015, 3); c.fill();
  const g = c.createLinearGradient(-wid / 2, 0, wid / 2, 0); g.addColorStop(0, 'rgba(0,0,0,.18)'); g.addColorStop(.5, 'rgba(255,255,255,.12)'); g.addColorStop(1, 'rgba(0,0,0,.18)');
  c.fillStyle = g; c.fillRect(-wid / 2, -len / 2 + cabL, wid, len - cabL);
  c.strokeStyle = 'rgba(0,0,0,.15)'; c.lineWidth = 1;
  for (let k = 1; k < 8; k++) { const y = -len / 2 + cabL + k * (len - cabL) / 8; c.beginPath(); c.moveTo(-wid / 2 + 2, y); c.lineTo(wid / 2 - 2, y); c.stroke(); }
  const cg = c.createLinearGradient(-wid / 2, 0, wid / 2, 0); cg.addColorStop(0, shade(cab, -45)); cg.addColorStop(.5, shade(cab, 25)); cg.addColorStop(1, shade(cab, -45));
  c.fillStyle = cg; rr(c, -wid * .48, -len / 2, wid * .96, cabL, wid * .16); c.fill();
  c.fillStyle = '#18222c'; rr(c, -wid * .4, -len / 2 + cabL * .1, wid * .8, cabL * .22, 2); c.fill();
  c.fillStyle = shade(cab, -20); rr(c, -wid * .4, -len / 2 + cabL * .45, wid * .8, cabL * .45, 3); c.fill();
}

function drawVehicle(x, z, kind, color, dir, opts = {}) {
  const c = ctx;
  const T = V.VEHICLE_TYPES[kind] || V.VEHICLE_TYPES.car;
  const len = T.len * ppm * VSCALE, wid = T.width * ppm * VSCALE;
  const cx = x, cy = sy(z);
  if (cy < -len || cy > H + len) return null;
  c.save(); c.translate(cx, cy); if (dir > 0) c.rotate(Math.PI);
  // sombra suave
  c.fillStyle = 'rgba(0,0,0,.22)'; rr(c, -wid / 2 + 1, -len / 2 + 3, wid + 6, len + 6, wid * .35); c.fill();
  c.fillStyle = 'rgba(0,0,0,.3)'; rr(c, -wid / 2 + 3, -len / 2 + 5, wid, len, wid * .3); c.fill();
  const CAB_FRAC = { truck: 2.3 / 16.5, toco: 2.1 / 9.2, truck34: 1.9 / 6.9 };
  if (CAB_FRAC[kind]) truck(c, len, wid, opts.cab || '#f4f4f2', opts.box || '#eceeef', CAB_FRAC[kind]);
  else if (kind === 'pickup') pickup(c, len, wid, color);
  else sedan(c, len, wid, color, kind === 'van', kind === 'gol');
  // faróis
  const n = env.night;
  c.save(); c.shadowColor = '#fff6d8'; c.shadowBlur = 8 + n * 14; c.fillStyle = '#fffaf0';
  for (const s of [-1, 1]) { c.beginPath(); c.ellipse(s * wid * .3, -len / 2 + wid * .07, wid * .13, wid * .05, 0, 0, 7); c.fill(); }
  c.restore();
  // lanternas
  const brake = opts.brake;
  c.save(); c.shadowColor = '#ff1a1a'; c.shadowBlur = brake ? 22 : 6 + n * 12;
  c.fillStyle = brake ? '#ff3030' : `rgba(220,25,25,${.75 + n * .25})`;
  for (const s of [-1, 1]) rr(c, s * wid * .32 - wid * .13, len / 2 - wid * .07, wid * .26, wid * .06, 2), c.fill();
  c.restore();
  if (opts.hazard) {
    c.save(); c.fillStyle = '#ffb22c'; c.shadowColor = '#ffb22c'; c.shadowBlur = 18;
    for (const [px, py] of [[-wid / 2, -len / 2 + 4], [wid / 2, -len / 2 + 4], [-wid / 2, len / 2 - 4], [wid / 2, len / 2 - 4]]) { c.beginPath(); c.arc(px, py, 4, 0, 7); c.fill(); }
    c.restore();
  }
  c.restore();
  return { cx, cy, len, wid, dir };
}

// Escurecimento noturno com recortes de luz.
function drawNight(lights) {
  const n = env.night; if (n < .02) return;
  const d = darkCtx;
  d.setTransform(1, 0, 0, 1, 0, 0); d.globalCompositeOperation = 'source-over';
  d.clearRect(0, 0, darkLayer.width, darkLayer.height);
  d.fillStyle = `rgba(3,8,22,${n * .7})`; d.fillRect(0, 0, darkLayer.width, darkLayer.height);
  d.setTransform(dpr, 0, 0, dpr, 0, 0);
  d.globalCompositeOperation = 'destination-out';
  for (const L of lights) {
    const reach = (L.ego ? 40 : 24) * ppm, base = L.cy + L.dir * L.len / 2, tip = base + L.dir * reach;
    const g = d.createLinearGradient(0, base, 0, tip); g.addColorStop(0, 'rgba(0,0,0,.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    d.fillStyle = g; d.beginPath(); d.moveTo(L.cx - L.wid * .4, base); d.lineTo(L.cx + L.wid * .4, base); d.lineTo(L.cx + L.wid * 1.4, tip); d.lineTo(L.cx - L.wid * 1.4, tip); d.closePath(); d.fill();
    const r = L.wid * 1.3, g2 = d.createRadialGradient(L.cx, L.cy, 0, L.cx, L.cy, r + L.len / 2);
    g2.addColorStop(0, 'rgba(0,0,0,.5)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
    d.fillStyle = g2; d.beginPath(); d.arc(L.cx, L.cy, r + L.len / 2, 0, 7); d.fill();
  }
  d.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(darkLayer, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function render() {
  if (state.viewMode !== '2d' || !W) return;
  drawFrame(false);
}

// Mesma cena em tamanho reduzido (tela "Visão 2D - simplificada" da cabine 3D).
const mini = { canvas: null, dark: null };
function renderMini(w, h) {
  if (!ctx || !grassPat || w < 10 || h < 10) return null;
  if (!mini.canvas) { mini.canvas = document.createElement('canvas'); mini.dark = document.createElement('canvas'); }
  const d = 1, cw = Math.round(w * d), ch = Math.round(h * d); // tela pequena: 1x basta e é bem mais leve
  if (mini.canvas.width !== cw || mini.canvas.height !== ch) { mini.canvas.width = mini.dark.width = cw; mini.canvas.height = mini.dark.height = ch; }
  const saved = [ctx, W, H, dpr, ppm, lane, CX, darkLayer, darkCtx];
  ctx = mini.canvas.getContext('2d'); darkLayer = mini.dark; darkCtx = mini.dark.getContext('2d');
  W = w; H = h; dpr = d; CX = w / 2; lane = w * .3; ppm = clamp(h / 62, 1.5, 18);
  try { drawFrame(true); }
  finally { [ctx, W, H, dpr, ppm, lane, CX, darkLayer, darkCtx] = saved; }
  return mini.canvas;
}

function drawFrame(small) {
  const c = ctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scroll = world.distance * ppm;
  drawGround(scroll);
  drawVegetation();
  drawCity();
  drawSigns();
  if (!small) drawLaneLabels();

  const n = env.night, R = V.ROAD;
  const opp = lx(-.5), own = lx(.5);
  const inter = !state.degraded && state.level === 'intervention';
  const vis = [];
  for (const t of world.traffic) vis.push({ x: opp, z: t.z, kind: t.kind, color: t.color || '#b7bec7', dir: 1, opts: { cab: t.cab, box: t.color } });
  if (world.lead) vis.push({ x: own, z: world.lead.z, kind: world.lead.kind, color: world.lead.color, dir: -1, opts: { cab: world.lead.cab, box: world.lead.color } });
  if (world.follower) vis.push({ x: own, z: world.follower.z, kind: world.follower.kind, color: world.follower.color, dir: -1, opts: { cab: world.follower.cab, box: world.follower.color } });
  vis.push({ x: own, z: V.egoExtent().center, kind: state.vehicle, color: '#2f7fd6', dir: -1, ego: true, opts: { cab: '#1f5fa8', box: '#eef0f2', brake: inter && state.speed > .5, hazard: state.hazardOn } });

  // fachos de luz sobre o asfalto (sempre acesos; mais fortes à noite)
  for (const v of vis) {
    const T = V.VEHICLE_TYPES[v.kind] || V.VEHICLE_TYPES.car;
    const len = T.len * ppm * VSCALE, wid = T.width * ppm * VSCALE;
    const front = sy(v.z) + v.dir * len / 2;
    if (v.ego) beam(v.x, front, -1, 19 * ppm, wid * .9, '150,200,255', .22 + n * .3);
    else if (v.dir > 0) beam(v.x, front, 1, 13 * ppm, wid * .8, '255,226,160', .12 + n * .18);
  }
  const lights = [];
  for (const v of vis) {
    const r = drawVehicle(v.x, v.z, v.kind, v.color, v.dir, v.opts);
    if (r && (v.ego || v.dir > 0)) lights.push({ ...r, ego: v.ego });
  }
  drawNight(lights);
}

V.on('ready', () => {
  canvas = document.getElementById('view2d');
  ctx = canvas.getContext('2d');
  darkLayer = document.createElement('canvas'); darkCtx = darkLayer.getContext('2d');
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();
});
V.addRenderer(render);
V.scene2d = { renderMini };
})();
