/* VIGIA v0.6 — mundo 3D (Three.js / WebGL).
 * A câmera fica parada na posição do motorista e o mundo se desloca em direção a ela.
 * Coordenadas: metros. Eixo -Z = à frente. Faixa própria em x>0, contrária em x<0.
 * Os retrovisores são renderizações reais da cena (câmeras traseiras espelhadas). */
(() => {
'use strict';
const V = window.VIGIA;
if (!V) return;
const { state, world, env, clamp, lerp } = V;

let THREE, renderer, scene, camera, rearCams, ready = false, failed = false;
let container, glCanvas;
const R = {}; // referências da cena

/* ---------- utilitários ---------- */
// x do veículo próprio: centro da faixa + deslocamento para o acostamento (core.js)
const egoX = () => V.ROAD.egoLaneX + world.egoOffset;
function hash(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const h = (a, b) => hash(a * 57 + b * 131);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}
function fbm(x, y) { let a = 0, f = 1, amp = .5; for (let i = 0; i < 5; i++) { a += amp * vnoise(x * f, y * f); f *= 2; amp *= .5; } return a; }
function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function noiseFill(ctx, w, h, base, spread, seed = 1) {
  const img = ctx.createImageData(w, h), d = img.data, r = rng(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - .5) * spread;
    d[i] = base[0] + n; d[i + 1] = base[1] + n; d[i + 2] = base[2] + n; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
const C = hex => new THREE.Color(hex);
function lerpColor(a, b, t) { return a.clone().lerp(b, t); }

/* ---------- texturas ---------- */
/* Pista: quatro faixas de 3,6 m (duas de contramão, a de ultrapassagem e a da direita) e 0,6 m de
 * borda de cada lado, de x = -11,4 a 4,2 (centro em ROAD_CX). Na textura, x vai de 0 (borda
 * esquerda) a ROAD_W. Pinturas: linhas de bordo brancas a 0,6 m das bordas, faixa dupla amarela
 * contínua entre a contramão e o nosso sentido (x = -3,6) e linha branca tracejada entre as duas
 * faixas de cada sentido (x = 0 e x = -7,2). Tudo o que fica à esquerda da pista (acostamento, guard-rail, calçada, prédios,
 * árvores) fica ESQ metros além do lado direito (veja scroller). */
const ROAD_W = 15.6, ROAD_TILE = 16.8, ROAD_CX = -3.6, ESQ = V.ROAD.esq;
const texX = x => x - (ROAD_CX - ROAD_W / 2); // x do mundo -> x na textura da pista
const SHOULDER_W = 2.1, GRAVEL_W = .9; // acostamento asfaltado e cascalho até o guard-rail (6,58 m)
function makeAsphalt() {
  return canvasTex(1024, 2048, (ctx, w, h) => {
    noiseFill(ctx, w, h, [78, 81, 84], 34, 7);
    const ppm = w / ROAD_W;
    const r = rng(11);
    // agregados e manchas
    for (let i = 0; i < 2600; i++) { ctx.fillStyle = `rgba(${r() < .5 ? 25 : 150},${r() < .5 ? 27 : 150},${r() < .5 ? 30 : 152},${.05 + r() * .12})`; ctx.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3); }
    for (let i = 0; i < 26; i++) { ctx.fillStyle = `rgba(20,22,24,${.04 + r() * .07})`; ctx.beginPath(); ctx.ellipse(r() * w, r() * h, 20 + r() * 90, 30 + r() * 180, r() * 3, 0, 7); ctx.fill(); }
    // trilhas de pneus mais escuras e polidas
    for (const lx of [-9, -5.4, -1.8, 1.8].flatMap(c => [texX(c) - .72, texX(c) + .72])) {
      const g = ctx.createLinearGradient((lx - .45) * ppm, 0, (lx + .45) * ppm, 0);
      g.addColorStop(0, 'rgba(25,27,30,0)'); g.addColorStop(.5, 'rgba(25,27,30,.22)'); g.addColorStop(1, 'rgba(25,27,30,0)');
      ctx.fillStyle = g; ctx.fillRect((lx - .45) * ppm, 0, .9 * ppm, h);
    }
    // remendos e trincas
    for (let i = 0; i < 4; i++) { ctx.fillStyle = 'rgba(40,42,45,.55)'; ctx.fillRect(r() * w * .8, r() * h, 60 + r() * 140, 80 + r() * 200); }
    ctx.strokeStyle = 'rgba(25,25,25,.5)'; ctx.lineWidth = 1.4;
    for (let i = 0; i < 14; i++) { ctx.beginPath(); let x = r() * w, y = r() * h; ctx.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - .5) * 40; y += r() * 40; ctx.lineTo(x, y); } ctx.stroke(); }
    const line = (x, wid, color) => {
      ctx.fillStyle = color; ctx.fillRect((x - wid / 2) * ppm, 0, wid * ppm, h);
      ctx.fillStyle = 'rgba(70,70,70,.25)';
      for (let i = 0; i < 900; i++) ctx.fillRect((x - wid / 2) * ppm + r() * wid * ppm, r() * h, 2, 2);
    };
    line(.6, .15, '#e6e6e0'); line(ROAD_W - .6, .15, '#e6e6e0');
    // as linhas do meio (dupla amarela e tracejados) não estão na textura: são peças próprias
    // (linhasDoMeio), para sumirem inteiras sob o logo da largada
  }, true);
}
// Acostamento: o mesmo asfalto, um pouco mais claro e gasto, sem faixas nem trilhas de pneus.
function makeShoulder() {
  return canvasTex(256, 1024, (ctx, w, h) => {
    noiseFill(ctx, w, h, [88, 90, 92], 36, 21);
    const r = rng(23);
    for (let i = 0; i < 900; i++) { ctx.fillStyle = `rgba(${r() < .5 ? 30 : 160},${r() < .5 ? 32 : 160},${r() < .5 ? 34 : 160},${.05 + r() * .12})`; ctx.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3); }
    for (let i = 0; i < 10; i++) { ctx.fillStyle = `rgba(20,22,24,${.04 + r() * .06})`; ctx.beginPath(); ctx.ellipse(r() * w, r() * h, 10 + r() * 40, 20 + r() * 90, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = 'rgba(160,150,120,.18)'; ctx.fillRect(w - 10, 0, 10, h); // poeira junto ao cascalho
  }, true);
}
function makeGravel() {
  return canvasTex(256, 512, (ctx, w, h) => {
    noiseFill(ctx, w, h, [112, 106, 96], 50, 3);
    const r = rng(5);
    for (let i = 0; i < 500; i++) { ctx.fillStyle = `rgba(${60 + r() * 120},${60 + r() * 100},${50 + r() * 80},.5)`; ctx.fillRect(r() * w, r() * h, 2 + r() * 3, 2 + r() * 3); }
    const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, 'rgba(70,72,74,.55)'); g.addColorStop(.35, 'rgba(70,72,74,0)'); g.addColorStop(.75, 'rgba(90,110,60,0)'); g.addColorStop(1, 'rgba(90,110,60,.6)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }, true);
}
function makeGrass() {
  return canvasTex(512, 512, (ctx, w, h) => {
    noiseFill(ctx, w, h, [92, 118, 58], 44, 9);
    const r = rng(13);
    for (let i = 0; i < 60; i++) { ctx.fillStyle = r() < .5 ? `rgba(140,140,70,${.08 + r() * .12})` : `rgba(40,70,30,${.08 + r() * .14})`; ctx.beginPath(); ctx.arc(r() * w, r() * h, 10 + r() * 60, 0, 7); ctx.fill(); }
    for (let i = 0; i < 5000; i++) { ctx.strokeStyle = `rgba(${50 + r() * 90},${80 + r() * 90},${30 + r() * 40},.5)`; const x = r() * w, y = r() * h; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (r() - .5) * 3, y - 2 - r() * 5); ctx.stroke(); }
  }, true);
}
function makeCloudTex(seed) {
  return canvasTex(512, 256, (ctx, w, h) => {
    const r = rng(seed);
    for (let i = 0; i < 26; i++) {
      const x = w * (.18 + r() * .64), y = h * (.45 + (r() - .5) * .35), rad = 30 + r() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(.6, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
    }
  });
}
function radialTex(stops, size = 128) {
  return canvasTex(size, size, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    stops.forEach(([o, c]) => g.addColorStop(o, c)); ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
  });
}
function beamTex() {
  return canvasTex(128, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(255,246,210,.85)'); g.addColorStop(.4, 'rgba(255,246,210,.35)'); g.addColorStop(1, 'rgba(255,246,210,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(w * .42, h); ctx.lineTo(w * .58, h); ctx.lineTo(w, 0); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
  });
}
// Facho dos faróis do veículo próprio projetado no asfalto (mancha suave, mais larga ao longe).
function egoBeamTex() {
  return canvasTex(256, 512, (ctx, w, h) => {
    ctx.filter = 'blur(16px)';
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.08, 'rgba(255,255,255,.95)');
    g.addColorStop(.45, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(w * .3, h - 20); ctx.lineTo(w * .7, h - 20); ctx.lineTo(w - 18, 30); ctx.lineTo(18, 30); ctx.closePath(); ctx.fill();
  });
}
const texMemo = new Map();
function memoTex(key, make) { if (!texMemo.has(key)) texMemo.set(key, make()); return texMemo.get(key); }
function ribTex(color) { return memoTex('rib' + color, () => makeRibTex(color)); }
function doorTex(color) { return memoTex('door' + color, () => makeDoorTex(color)); }
function makeRibTex(color) {
  return canvasTex(512, 128, (ctx, w, h) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 12) { ctx.fillStyle = 'rgba(0,0,0,.07)'; ctx.fillRect(x, 0, 3, h); ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x + 3, 0, 2, h); }
    ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(0, h - 6, w, 6); ctx.fillRect(0, 0, w, 3);
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(60,50,40,.18)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
}
function makeDoorTex(color) {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 3; ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.beginPath(); ctx.moveTo(w / 2, 6); ctx.lineTo(w / 2, h - 6); ctx.stroke();
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(80,80,80,.8)';
    for (const x of [w * .3, w * .4, w * .6, w * .7]) { ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, h - 14); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(w * .1, h * .88, w * .8, h * .05);
    ctx.fillStyle = '#c62828'; for (let x = w * .1; x < w * .9; x += 22) ctx.fillRect(x, h * .88, 11, h * .05);
  });
}
function signTex(kind, value) {
  const font = (w, s) => `${w} ${s}px Arial, "Helvetica Neue", sans-serif`;
  const board = (w, h, bg, fg, draw) => canvasTex(w, h, (ctx) => {
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = fg; ctx.lineWidth = 8; ctx.strokeRect(12, 12, w - 24, h - 24);
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; draw(ctx, w, h);
  });
  if (kind === 'animals') return canvasTex(256, 256, (ctx, w) => { // A-36: animais na pista
    ctx.translate(w / 2, w / 2); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#111'; ctx.fillRect(-88, -88, 176, 176);
    ctx.fillStyle = '#f5c400'; ctx.fillRect(-80, -80, 160, 160);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#111';
    // silhueta de vaca
    ctx.beginPath(); ctx.ellipse(124, 136, 46, 24, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(76, 118, 15, 12, -.4, 0, 7); ctx.fill();
    ctx.fillRect(66, 104, 6, 10); ctx.fillRect(80, 102, 6, 10);
    for (const x of [90, 104, 146, 160]) ctx.fillRect(x, 150, 9, 36);
    ctx.lineWidth = 5; ctx.strokeStyle = '#111'; ctx.beginPath(); ctx.moveTo(168, 128); ctx.quadraticCurveTo(184, 140, 178, 168); ctx.stroke();
  });
  if (kind === 'noPassing') return canvasTex(256, 256, (ctx, w) => { // R-7: proibido ultrapassar
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(w / 2, w / 2, w / 2 - 2, 0, 7); ctx.fill();
    ctx.strokeStyle = '#d0141e'; ctx.lineWidth = 28; ctx.beginPath(); ctx.arc(w / 2, w / 2, w / 2 - 18, 0, 7); ctx.stroke();
    const car = (x, color) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 26, 112, 52, 44, 8) : ctx.rect(x - 26, 112, 52, 44); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x - 20, 112); ctx.lineTo(x - 14, 92); ctx.lineTo(x + 14, 92); ctx.lineTo(x + 20, 112); ctx.fill();
      ctx.fillRect(x - 24, 156, 12, 10); ctx.fillRect(x + 12, 156, 12, 10);
    };
    car(100, '#d0141e'); car(158, '#111');
    ctx.strokeStyle = '#d0141e'; ctx.lineWidth = 20; ctx.beginPath(); ctx.moveTo(62, 62); ctx.lineTo(194, 194); ctx.stroke();
  });
  if (kind === 'rest') return board(512, 256, '#1557b0', '#fff', (ctx, w) => { // educativa sobre sonolência
    ctx.font = font(900, 54); ctx.fillText('CANSADO?', w / 2 + 40, 70);
    ctx.font = font(800, 40); ctx.fillText('PARE E DESCANSE', w / 2 + 40, 128);
    ctx.font = font(700, 28); ctx.fillText('PONTO DE PARADA  2 km', w / 2 + 40, 190);
    // xícara
    ctx.fillStyle = '#fff'; ctx.fillRect(40, 92, 64, 56); ctx.lineWidth = 9; ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(108, 118, 16, -Math.PI / 2, Math.PI / 2); ctx.stroke(); ctx.fillRect(30, 154, 88, 9);
    for (const x of [56, 72, 88]) { ctx.beginPath(); ctx.moveTo(x, 82); ctx.quadraticCurveTo(x + 10, 68, x, 52); ctx.stroke(); }
  });
  if (kind === 'belt') return board(512, 200, '#fff', '#111', (ctx, w) => {
    ctx.font = font(900, 52); ctx.fillText('USE O CINTO', w / 2, 76); ctx.font = font(800, 40); ctx.fillText('DE SEGURANÇA', w / 2, 136);
  });
  if (kind === 'distance') return board(512, 200, '#fff', '#111', (ctx, w) => {
    ctx.font = font(900, 50); ctx.fillText('MANTENHA', w / 2, 76); ctx.font = font(800, 40); ctx.fillText('DISTÂNCIA SEGURA', w / 2, 136);
  });
  if (kind === 'city') return board(512, 300, '#0d6b3a', '#fff', (ctx, w) => { // placa verde de direção
    value.forEach(([name, km], i) => {
      const y = 70 + i * 80;
      ctx.textAlign = 'left'; ctx.font = font(800, 36); ctx.fillText(name, 40, y);
      ctx.textAlign = 'right'; ctx.font = font(900, 36); ctx.fillText(km + ' km', w - 40, y);
      if (i < value.length - 1) { ctx.fillRect(36, y + 40, w - 72, 3); }
    });
  });
  if (kind === 'welcome') return board(512, 256, '#1557b0', '#fff', (ctx, w) => { // entrada da cidade
    ctx.font = font(800, 34); ctx.fillText('BEM-VINDO A', w / 2, 62);
    ctx.font = font(900, value.length > 9 ? 62 : 72); ctx.fillText(value, w / 2, 132);
    ctx.font = font(700, 26); ctx.fillText('PERÍMETRO URBANO', w / 2, 200);
  });
  if (kind === 'pedestrian') return canvasTex(256, 256, (ctx, w) => { // A-32b: passagem de pedestres
    ctx.translate(w / 2, w / 2); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#111'; ctx.fillRect(-88, -88, 176, 176); ctx.fillStyle = '#f5c400'; ctx.fillRect(-80, -80, 160, 160);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#111'; ctx.strokeStyle = '#111'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(130, 72, 13, 0, 7); ctx.fill();
    ctx.lineWidth = 15; ctx.beginPath(); ctx.moveTo(126, 92); ctx.lineTo(118, 140); ctx.stroke();
    ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(118, 140); ctx.lineTo(100, 182); ctx.moveTo(118, 140); ctx.lineTo(140, 180); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(124, 100); ctx.lineTo(102, 124); ctx.moveTo(124, 100); ctx.lineTo(146, 118); ctx.stroke();
    ctx.fillRect(70, 196, 116, 8);
  });
  if (kind === 'busStop') return board(256, 320, '#1557b0', '#fff', (ctx, w) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(60, 60, 136, 110); ctx.fillStyle = '#1557b0';
    ctx.fillRect(74, 74, 108, 44); ctx.fillRect(80, 150, 22, 22); ctx.fillRect(154, 150, 22, 22);
    ctx.fillStyle = '#fff'; ctx.font = font(900, 34); ctx.fillText('PONTO DE', w / 2, 220); ctx.fillText('ÔNIBUS', w / 2, 262);
  });
  if (kind === 'vigia') return canvasTex(512, 180, (ctx, w, h) => {
    ctx.fillStyle = '#1557b0'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#fff'; ctx.lineWidth = 7; ctx.strokeRect(9, 9, w - 18, h - 18);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '900 92px Arial, sans-serif'; ctx.fillText('VIGIA', w / 2, 108);
    ctx.font = '700 25px Arial, sans-serif'; ctx.fillText('SISTEMA DE SEGURANÇA VIÁRIA', w / 2, 150);
  });
  if (kind === 'km') return canvasTex(128, 160, (ctx, w, h) => {
    ctx.fillStyle = '#1557b0'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '800 30px Arial'; ctx.fillText('KM', w / 2, 52); ctx.font = '900 50px Arial'; ctx.fillText(String(value), w / 2, 120);
  });
}

/* ---------- construção da cena ---------- */
function std(color, opts = {}) { return new THREE.MeshStandardMaterial({ color, roughness: .7, metalness: .05, ...opts }); }
function lam(color, opts = {}) { return new THREE.MeshLambertMaterial({ color, ...opts }); }

function buildSky() {
  const geo = new THREE.SphereGeometry(1800, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: C('#3d7fd1') }, horizon: { value: C('#b9d6ee') }, bottom: { value: C('#8aa4b4') }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: C('#fff3d6') }, sunGlow: { value: 1 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunGlow; varying vec3 vDir;
      void main(){ float h = vDir.y; vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, bottom, clamp(-h*6.0,0.0,1.0));
      float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
      col += sunColor * (pow(d, 9.0) * 0.35 + pow(d, 120.0) * 0.6) * sunGlow;
      gl_FragColor = vec4(col, 1.0); }`
  });
  R.sky = new THREE.Mesh(geo, mat); scene.add(R.sky);

  // estrelas
  const pts = [], r = rng(21);
  for (let i = 0; i < 1400; i++) { const th = r() * Math.PI * 2, ph = Math.acos(r() * .95); pts.push(Math.sin(ph) * Math.cos(th) * 1700, Math.cos(ph) * 1700, Math.sin(ph) * Math.sin(th) * 1700); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  R.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(R.stars);

  R.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTex([[0, 'rgba(255,255,240,1)'], [.18, 'rgba(255,250,220,1)'], [.3, 'rgba(255,220,150,.35)'], [1, 'rgba(255,200,120,0)']]), blending: THREE.AdditiveBlending, fog: false, depthWrite: false }));
  R.sun.scale.set(260, 260, 1); scene.add(R.sun);
  R.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTex([[0, 'rgba(240,245,255,1)'], [.14, 'rgba(225,232,250,1)'], [.17, 'rgba(160,190,255,.25)'], [1, 'rgba(120,150,255,0)']]), fog: false, transparent: true, depthWrite: false }));
  R.moon.scale.set(170, 170, 1); scene.add(R.moon);

  R.clouds = [];
  const cr = rng(33);
  for (let i = 0; i < 16; i++) {
    const m = new THREE.SpriteMaterial({ map: makeCloudTex(40 + i), transparent: true, fog: false, depthWrite: false, opacity: .9 });
    const s = new THREE.Sprite(m);
    const ang = -Math.PI / 2 + (cr() - .5) * 2.6, dist = 700 + cr() * 600;
    s.position.set(Math.cos(ang) * dist, 140 + cr() * 220, Math.sin(ang) * dist);
    const sc = 320 + cr() * 380; s.scale.set(sc, sc * .45, 1);
    s.userData.drift = 2 + cr() * 4;
    scene.add(s); R.clouds.push(s);
  }
}

/* Linhas do meio da pista: dupla amarela contínua entre os dois sentidos (x = -3,6) e tracejado
 * branco entre as duas faixas de cada sentido (x = 0 e -7,2; 4,2 m pintados a cada ~16,8 m). Cada
 * traço e cada trecho de 4,2 m da dupla amarela é uma peça: sob o logo da largada some inteira
 * (modo 'semLogo'), sem remendo nem pedaço cortado. */
function linhasDoMeio() {
  const tracos = [], amarelas = [], passoT = WRAP / Math.round(WRAP / 16.8), passoA = WRAP / Math.round(WRAP / 4.2);
  for (let z = Z_FAR; z < Z_BACK - .01; z += passoT) for (const x of [0, -7.2]) tracos.push({ x, y: .006, z, fixo: true });
  for (let z = Z_FAR; z < Z_BACK - .01; z += passoA) for (const x of [-3.72, -3.48]) amarelas.push({ x, y: .006, z, fixo: true });
  scroller(new THREE.BoxGeometry(.15, .012, 4.2), lam('#e6e6e0'), tracos, false, 'semLogo');
  scroller(new THREE.BoxGeometry(.12, .012, passoA + .01), lam('#e0b52a'), amarelas, false, 'semLogo');
}
function buildTerrain() {
  R.tex = { asphalt: makeAsphalt(), shoulder: makeShoulder(), gravel: makeGravel(), grass: makeGrass() };
  // Vai de BEHIND metros atrás até ~1040 m à frente: os retrovisores também enxergam pista e chão.
  const LEN = 1360, BEHIND = 320, cz = -LEN / 2 + BEHIND;
  R.tex.asphalt.repeat.set(1, LEN / ROAD_TILE);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, LEN), std(0xffffff, { map: R.tex.asphalt, roughness: .92 }));
  road.rotation.x = -Math.PI / 2; road.position.set(ROAD_CX, 0, cz); road.receiveShadow = true; scene.add(road);
  R.tex.gravel.repeat.set(1, LEN / 6);
  R.tex.shoulder.repeat.set(1, LEN / ROAD_TILE);
  for (const side of [-1, 1]) {
    // acostamento asfaltado logo depois da linha de bordo (é onde o veículo para na intervenção)
    const borda = side > 0 ? ROAD_CX + ROAD_W / 2 : -(ROAD_CX - ROAD_W / 2); // distância da borda ao eixo x = 0
    const ac = new THREE.Mesh(new THREE.PlaneGeometry(SHOULDER_W, LEN), std(0xffffff, { map: R.tex.shoulder, roughness: .94 }));
    ac.rotation.x = -Math.PI / 2; ac.position.set(side * (borda + SHOULDER_W / 2), -.005, cz);
    if (side < 0) ac.scale.x = -1;
    ac.receiveShadow = true; scene.add(ac);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(GRAVEL_W, LEN), std(0xffffff, { map: R.tex.gravel, roughness: 1 }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(side * (borda + SHOULDER_W + GRAVEL_W / 2), -.02, cz);
    if (side < 0) sh.scale.x = -1;
    sh.receiveShadow = true; scene.add(sh);
  }
  linhasDoMeio();
  R.tex.grass.repeat.set(120, LEN / 5);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, LEN), std(0xffffff, { map: R.tex.grass, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, -.08, cz); ground.receiveShadow = true; scene.add(ground);

  // colinas distantes (estáticas: a paralaxe é desprezível nessa distância)
  const hg = new THREE.PlaneGeometry(3000, 1500, 150, 60);
  hg.rotateX(-Math.PI / 2);
  const pos = hg.attributes.position, colors = [];
  const cLow = C('#55783a'), cMid = C('#45663a'), cHigh = C('#5d7564');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i) - 600; // z no mundo
    const corridor = clamp((Math.abs(x) - 140) / 260, 0, 1) * clamp((-z - 150) / 300, 0, 1);
    const far = clamp((-z - 620) / 500, 0, 1) * clamp((Math.abs(x) + 40) / 200, .25, 1);
    const mask = Math.max(corridor, far * .85);
    const n = fbm(x / 260, z / 260);
    const y = Math.max(0, (n - .3)) * 260 * mask + n * 10 * mask;
    pos.setY(i, y - 2);
    const t = clamp(y / 140, 0, 1);
    const c = t < .5 ? lerpColor(cLow, cMid, t * 2) : lerpColor(cMid, cHigh, (t - .5) * 2);
    colors.push(c.r, c.g, c.b);
  }
  hg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  hg.computeVertexNormals();
  const hills = new THREE.Mesh(hg, lam(0xffffff, { vertexColors: true }));
  hills.position.z = -600; scene.add(hills);
}

// Faixa do mundo onde ficam os objetos que "rolam" em direção à câmera.
// Ao entrar (à frente) eles crescem do chão; ao sair (atrás, nos retrovisores) encolhem suavemente.
const Z_FAR = -560, Z_BACK = 300, WRAP = Z_BACK - Z_FAR, FADE = 120;
const FENCE_X = -19; // cerca do pasto (lado esquerdo)
if (V.WORLD_WRAP !== WRAP) console.warn('VIGIA: WORLD_WRAP do núcleo difere da faixa do cenário 3D');

/* A rolagem acontece no shader: as matrizes das instâncias ficam fixas na GPU e cada vértice
 * calcula a própria posição (z + deslocamento, com volta na faixa). Assim não há reenvio de
 * milhares de matrizes por quadro, e cada objeto fica sempre inteiro: entra e sai da faixa
 * se dissolvendo na névoa, em vez de crescer do chão. A zona (cidade/campo) de cada objeto é
 * decidida pela posição dele na rodovia, no meio da transição, e não muda enquanto ele passa. */
const SCROLL = { uScrollD: { value: 0 }, uZoneRel: { value: new Float32Array(8) }, uZoneCity: { value: new Float32Array(8) }, uZoneN: { value: 1 },
  uLogo: { value: new Float32Array([1e9, 1e9]) }, // trecho do logo da largada [início, fim] (m, relativos ao ego)
  uLote: { value: new Float32Array(12) }, uLoteN: { value: 0 } }; // lotes reservados: [início, fim, lado] (m, relativos ao ego)
const ZONE_HALF = 45; // metade da faixa de transição entre cenários (ZONE_BLEND do núcleo)
const SCROLL_HEAD = `
uniform float uScrollD; uniform float uZoneRel[8]; uniform float uZoneCity[8]; uniform int uZoneN;
uniform float uLote[12]; uniform int uLoteN; uniform float uLogo[2];
varying float vScrollFade;
float scrollZ(float zb) { return mod(zb + uScrollD - (${Z_FAR.toFixed(1)}), ${WRAP.toFixed(1)}) + (${Z_FAR.toFixed(1)}); }
float scrollCity(float s) {
  float c = uZoneCity[0], prev = c, st = -1e6;
  for (int k = 1; k < 8; k++) { if (k >= uZoneN) break; if (uZoneRel[k] <= s) { prev = uZoneCity[k - 1]; c = uZoneCity[k]; st = uZoneRel[k]; } }
  return s - st >= ${ZONE_HALF.toFixed(1)} ? c : prev;
}
// 1 dentro de um lote reservado a um cartão-postal (trecho s e lado da via do objeto x)
float scrollLote(float s, float x) {
  for (int k = 0; k < 4; k++) { if (k >= uLoteN) break; if (s >= uLote[k * 3] && s <= uLote[k * 3 + 1] && x * uLote[k * 3 + 2] > 0.0) return 1.0; }
  return 0.0;
}
float scrollKeep(float z, float x) {
#if SCROLL_ZONE == 1
  return scrollCity(-z);
#elif SCROLL_ZONE == 3
  return scrollCity(-z) * (1.0 - scrollLote(-z, x));
#elif SCROLL_ZONE == 4
  return 1.0 - scrollLote(-z, x);
#elif SCROLL_ZONE == 5
  return (-z >= uLogo[0] && -z <= uLogo[1]) ? 0.0 : 1.0;
#elif SCROLL_ZONE == 2
  return 1.0 - scrollCity(-z);
#else
  return 1.0;
#endif
}
float scrollFade(float z) { return min(smoothstep(0.0, 1.0, (z - (${Z_FAR.toFixed(1)})) / ${FADE.toFixed(1)}), smoothstep(0.0, 1.0, (${Z_BACK.toFixed(1)} - z) / ${FADE.toFixed(1)})); }
`;
// p = posição já multiplicada pela matriz da instância
const SCROLL_MOVE = p => `
  { float zb = instanceMatrix[3][2], sz = scrollZ(zb), keep = scrollKeep(sz, instanceMatrix[3][0]);
    ${p}.xyz = mix(instanceMatrix[3].xyz, ${p}.xyz, keep); ${p}.z += sz - zb; vScrollFade = scrollFade(sz); }`;
// 'lote': cidade, mas some nos lotes reservados aos cartões-postais (casas, prédios, praças genéricas)
// 'semLote': em todo lugar, menos nos lotes reservados (postes da rede elétrica)
// 'semLogo': em todo lugar, menos sob o logo da largada (linhas do meio da pista)
const ZONE_CODE = { city: 1, field: 2, lote: 3, semLote: 4, semLogo: 5 };
function scrollShader(shader, mode, frag) {
  Object.assign(shader.uniforms, SCROLL);
  shader.vertexShader = `#define SCROLL_ZONE ${mode}\n` + SCROLL_HEAD + shader.vertexShader
    .replace('#include <project_vertex>', THREE.ShaderChunk.project_vertex.replace('mvPosition = instanceMatrix * mvPosition;', 'mvPosition = instanceMatrix * mvPosition;' + SCROLL_MOVE('mvPosition')))
    .replace('#include <worldpos_vertex>', THREE.ShaderChunk.worldpos_vertex.replace('worldPosition = instanceMatrix * worldPosition;', 'worldPosition = instanceMatrix * worldPosition;' + SCROLL_MOVE('worldPosition')));
  if (frag) shader.fragmentShader = 'varying float vScrollFade;\n' + shader.fragmentShader
    .replace('#include <fog_fragment>', '#include <fog_fragment>\n#ifdef USE_FOG\n  gl_FragColor.rgb = mix(fogColor, gl_FragColor.rgb, vScrollFade);\n#endif');
}
// Material com a rolagem; um material usado em zonas diferentes ganha uma cópia por zona.
function scrollMaterial(mat, mode) {
  const u = mat.userData;
  if (u.scrollMode === undefined) {
    u.scrollMode = mode;
    mat.onBeforeCompile = sh => scrollShader(sh, mode, true);
    mat.customProgramCacheKey = () => 'scroll' + mode;
    return mat;
  }
  if (u.scrollMode === mode) return mat;
  u.scrollCopies = u.scrollCopies || {};
  if (!u.scrollCopies[mode]) { const m = mat.clone(); m.userData = {}; u.scrollCopies[mode] = scrollMaterial(m, mode); }
  return u.scrollCopies[mode];
}
const depthMats = {};
function scrollDepth(mode) {
  if (!depthMats[mode]) {
    const m = depthMats[mode] = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.onBeforeCompile = sh => scrollShader(sh, mode, false);
    m.customProgramCacheKey = () => 'scrolldepth' + mode;
  }
  return depthMats[mode];
}

function scroller(geo, mat, items, castShadow = false, zone = null) {
  const mode = ZONE_CODE[zone] || 0;
  const mats = Array.isArray(mat) ? mat.map(m => scrollMaterial(m, mode)) : scrollMaterial(mat, mode);
  const mesh = new THREE.InstancedMesh(geo, mats, items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  items.forEach((it, i) => {
    e.set(it.rx || 0, it.ry || 0, it.rz || 0); q.setFromEuler(e);
    // lado esquerdo do cenário: além da contramão (ESQ); `fixo` = posição já na pista (faixa de pedestres)
    const x = it.x < 0 && !it.fixo ? it.x - ESQ : it.x;
    m.compose(new THREE.Vector3(x, it.y, it.z), q, new THREE.Vector3(it.sx || 1, it.sy || 1, it.sz || 1));
    mesh.setMatrixAt(i, m);
    if (it.color && mesh.setColorAt) mesh.setColorAt(i, it.color);
  });
  mesh.castShadow = castShadow; mesh.receiveShadow = true; mesh.frustumCulled = false;
  if (castShadow) mesh.customDepthMaterial = scrollDepth(mode);
  mesh.userData = { zone: zone === 'lote' ? 'city' : zone === 'semLote' || zone === 'semLogo' ? null : zone };
  scene.add(mesh); (R.scrollers = R.scrollers || []).push(mesh);
  return mesh;
}
// Por quadro: só o deslocamento, as zonas próximas e quais grupos têm algo na faixa.
function updateScrollers() {
  const D = world.distance, z = world.zones, U = SCROLL;
  U.uScrollD.value = ((D % WRAP) + WRAP) % WRAP;
  const n = Math.min(z.length, 8);
  for (let k = 0; k < n; k++) { U.uZoneRel.value[k] = k ? z[k].start - D : -1e6; U.uZoneCity.value[k] = z[k].type === 'city' ? 1 : 0; }
  U.uZoneN.value = n;
  let nl = 0;
  for (const p of world.postais) {
    if (nl >= 4 || Math.abs(p.S - D) > 1400) continue;
    U.uLote.value.set([p.S - V.POSTAL_MEIO - D, p.S + V.POSTAL_MEIO - D, p.lado], nl++ * 3);
  }
  U.uLoteN.value = nl;
  // logo da largada: as linhas do meio somem (peça inteira) no trecho dele, com folga
  const lg = world.largada, meio = LOGO_PISTA.largura / (1404 / 360) * LOGO_PISTA.alonga / 2 + 1.5;
  U.uLogo.value[0] = lg == null ? 1e9 : lg - meio - D; U.uLogo.value[1] = lg == null ? 1e9 : lg + meio - D;
  // trechos urbanos (já deslocados para o meio da transição) dentro da faixa visível
  const from = D - Z_BACK, to = D - Z_FAR;
  const city = V.cityRanges(from - ZONE_HALF, to - ZONE_HALF);
  const anyCity = city.length > 0, allCity = city.some(([a, b]) => a + ZONE_HALF <= from && b + ZONE_HALF >= to);
  for (const mesh of R.scrollers) {
    const zone = mesh.userData.zone;
    mesh.visible = zone === 'city' ? anyCity : zone === 'field' ? !allCity : true;
  }
}

/* ---------- vegetação ---------- */
// Junta várias geometrias (posição, normal e cor por vértice) numa só.
function mergeParts(parts) {
  const pos = [], nor = [], col = [];
  for (const { geo, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i));
      const c = color(p.getX(i), p.getY(i), p.getZ(i)); col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}
// Copa: aglomerado de esferas irregulares, mais escura embaixo e clara no topo (oclusão simulada).
function canopyParts(seed, lobes, top, bottom, light, dark, detalhe = 1) {
  const r = rng(seed), parts = [];
  const cL = C(light), cD = C(dark);
  for (const [ox, oy, oz, rad] of lobes) {
    const g = new THREE.IcosahedronGeometry(rad, detalhe); // detalhe 1: copa arredondada (80 triângulos); 0: 20, para longe
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + (vnoise(x * 1.7 + seed, z * 1.7 + y) - .5) * .28; // contorno irregular
      p.setXYZ(i, x * k + ox, y * k * .85 + oy, z * k + oz);
    }
    parts.push({ geo: g, color: (x, y) => {
      const t = clamp((y - bottom) / (top - bottom), 0, 1);
      return cD.clone().lerp(cL, Math.pow(t, .8)).multiplyScalar(.92 + r() * .16);
    } });
  }
  return parts;
}
function trunkPart(h, r0, r1, color, y0 = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, h, 7); g.translate(0, y0 + h / 2, 0);
  const c = C(color); return { geo: g, color: (x, y) => c.clone().multiplyScalar(.75 + clamp(y / h, 0, 1) * .3) };
}
// detalhe 0 (desempenho): copas com 1/4 dos triângulos, para a mata ao longe e os arbustos baixos,
// que são centenas de instâncias e quase não mostram o arredondado.
function buildTreeGeos(detalhe = 1) {
  return {
    // árvore de copa larga
    broad: mergeParts([trunkPart(3.2, .32, .2, '#5a4634'),
      ...canopyParts(3, [[0, 4.6, 0, 2.3], [1.5, 4.1, .6, 1.7], [-1.4, 4.2, -.4, 1.8], [.3, 5.6, -.8, 1.6], [-.5, 3.7, 1.3, 1.5]], 7.2, 2.6, '#7fa34a', '#2c4a22', detalhe)]),
    // árvore mais alta e estreita
    tall: mergeParts([trunkPart(4.4, .26, .16, '#5e4a38'),
      ...canopyParts(9, [[0, 5.6, 0, 1.8], [.6, 7, .2, 1.4], [-.5, 4.8, .4, 1.5], [.2, 8.1, -.2, 1.0]], 9.2, 3.8, '#86ab52', '#2f4f25', detalhe)]),
    // eucalipto: tronco claro e copa alta
    eucal: mergeParts([trunkPart(9, .2, .1, '#b9b2a2'),
      ...canopyParts(17, [[0, 10, 0, 1.4], [.5, 11.3, .3, 1.1], [-.4, 9.2, -.3, 1.2], [.1, 12.2, 0, .8]], 13, 8, '#8fa86a', '#3e5a33', detalhe)]),
    // arbusto baixo
    bush: mergeParts(canopyParts(23, [[0, .55, 0, .8], [.7, .45, .3, .6], [-.6, .45, -.2, .65], [.1, .9, .2, .5]], 1.4, 0, '#7a9c45', '#2a4320', detalhe))
  };
}

function buildRoadside() {
  const r = rng(77);
  const span = () => Z_FAR + r() * WRAP;
  // guard-rail: lâminas contínuas + postes rolantes
  const railMat = std('#b9bec3', { metalness: .55, roughness: .38 });
  const posts = [], blades = [], lips = [];
  for (let z = Z_FAR; z < Z_BACK; z += 4) for (const side of [-1, 1]) {
    posts.push({ x: side * 6.8, y: .38, z });
    blades.push({ x: side * 6.58, y: .62, z }); lips.push({ x: side * 6.58, y: .78, z });
  }
  scroller(new THREE.BoxGeometry(.08, .32, 4.02), railMat, blades, true, 'field');
  scroller(new THREE.BoxGeometry(.16, .05, 4.02), railMat, lips, false, 'field');
  scroller(new THREE.BoxGeometry(.12, .76, .12), std('#8d9298', { metalness: .4, roughness: .5 }), posts, true, 'field');
  const refl = [];
  for (let z = Z_FAR; z < Z_BACK; z += 20) for (const side of [-1, 1]) refl.push({ x: side * 6.56, y: .66, z, color: side > 0 ? C('#ffffff') : C('#ffb300') });
  R.reflectors = scroller(new THREE.BoxGeometry(.05, .1, .14), new THREE.MeshBasicMaterial({ color: 0xffffff }), refl, false, 'field');

  // cerca de madeira do pasto (lado esquerdo)
  const woodMat = lam('#7a5c3e');
  const fposts = [], frails = [];
  for (let z = Z_FAR; z < Z_BACK; z += 3) { fposts.push({ x: FENCE_X, y: .65, z, ry: r() * .3 }); frails.push({ x: FENCE_X, y: .55, z }, { x: FENCE_X, y: 1.0, z }); }
  scroller(new THREE.CylinderGeometry(.07, .09, 1.3, 6), woodMat, fposts, true, 'field');
  scroller(new THREE.BoxGeometry(.06, .1, 3.02), woodMat, frails, true, 'field');

  // vegetação (GL: menos detalhe, para a mata ao longe e os arbustos)
  const G = buildTreeGeos(), GL = buildTreeGeos(0);
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const tint = () => new THREE.Color(1, 1, 1).multiplyScalar(.85 + r() * .3);
  // "far" = mata distante: fica fora dos retrovisores, onde seria só alguns pixels
  const broad = [], tall = [], farBroad = [], farTall = [], eucal = [], bush = [];
  const tree = (list, x, z, s = .8 + r() * .5) => list.push({ x, y: 0, z, sx: s * (.9 + r() * .2), sy: s, sz: s * (.9 + r() * .2), ry: r() * 6.3, color: tint() });
  const native = (x, z) => tree(Math.abs(x) > 60 ? (r() < .65 ? farBroad : farTall) : (r() < .65 ? broad : tall), x, z);
  // lado direito: mata nativa densa
  for (let i = 0; i < 440; i++) native(12 + Math.pow(r(), 1.4) * 150, span());
  // lado direito, mais afastado: plantio de eucaliptos em fileiras
  for (let row = 0; row < 4; row++) for (let z = Z_FAR; z < Z_BACK; z += 9) if (r() < .85) tree(eucal, 70 + row * 7 + (r() - .5) * 1.5, z + (r() - .5) * 2, .85 + r() * .3);
  // lado esquerdo: fileira junto à pista, árvores isoladas no pasto e mata ao fundo
  for (let z = Z_FAR; z < Z_BACK; z += 18 + r() * 20) tree(r() < .6 ? broad : tall, -(12.5 + r() * 2.5), z);
  for (let i = 0; i < 14; i++) tree(broad, -(30 + r() * 40), span(), 1 + r() * .4);
  for (let i = 0; i < 200; i++) native(-(85 + Math.pow(r(), 1.3) * 90), span());
  // arbustos junto ao guard-rail e na cerca
  for (let i = 0; i < 280; i++) { const side = r() < .5 ? -1 : 1; bush.push({ x: side * (7.6 + r() * (side < 0 ? 4 : 9)), y: 0, z: span(), sx: .7 + r() * .9, sy: .6 + r() * .7, sz: .7 + r() * 1, ry: r() * 6, color: tint() }); }
  for (let i = 0; i < 80; i++) bush.push({ x: FENCE_X + (r() - .5) * 2, y: 0, z: span(), sx: .6 + r() * .6, sy: .5 + r() * .5, sz: .6 + r() * .8, ry: r() * 6, color: tint() });
  // sem sombra projetada nas árvores (custo alto); o sombreamento vem das cores da copa
  scroller(G.broad, treeMat, broad, false, 'field');
  scroller(G.tall, treeMat, tall, false, 'field');
  scroller(GL.bush, treeMat, bush, false, 'field');
  R.farVeg = [scroller(GL.broad, treeMat, farBroad, false, 'field'), scroller(GL.tall, treeMat, farTall, false, 'field'), scroller(GL.eucal, treeMat, eucal, false, 'field')];

  // postes da rede elétrica à esquerda
  const poles = [], arms = [];
  for (let z = Z_FAR; z < Z_BACK; z += 52) { poles.push({ x: -16, y: 4.5, z }); arms.push({ x: -16, y: 8.6, z }); }
  scroller(new THREE.CylinderGeometry(.13, .18, 9, 6), lam('#8b8174'), poles, true, 'semLote');
  scroller(new THREE.BoxGeometry(2.4, .12, .12), lam('#6d655b'), arms, false, 'semLote');
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2b2b2b });
  for (const dx of [-1.05, 0, 1.05]) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-16 - ESQ + dx, 8.5, Z_BACK), new THREE.Vector3(-16 - ESQ + dx, 8.5, -900)]);
    const fio = new THREE.Line(g, wireMat); scene.add(fio); (R.fios = R.fios || []).push(fio);
  }
}

/* ---------- cidade ----------
 * Tudo aqui usa a mesma faixa rolante do cenário e só aparece nos trechos urbanos
 * (zona 'city'); a vegetação/pasto/guard-rail somem nesses trechos (zona 'field'). */
// z inicial (dentro da faixa) de algo que deve ficar na posição S (mod WRAP) do mundo
function zOfS(offset) { return ((-offset - Z_FAR) % WRAP + WRAP) % WRAP + Z_FAR; }
const nearCross = z => V.CROSSINGS.some(o => { const dz = Math.abs(z - zOfS(o)); return Math.min(dz, WRAP - dz) < 16; });

function windowTex(wall, glass, lit, cols, rows) {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
    const cw = w / cols, rh = h / rows, r = rng(cols * 31 + rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const on = lit && r() < .45;
      ctx.fillStyle = lit ? (on ? '#ffd99a' : '#000') : glass;
      ctx.fillRect(i * cw + cw * .18, j * rh + rh * .22, cw * .64, rh * .56);
      if (!lit) { ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(i * cw + cw * .18, j * rh + rh * .22, cw * .64, rh * .12); }
    }
    if (!lit) { ctx.fillStyle = 'rgba(0,0,0,.08)'; for (let j = 1; j < rows; j++) ctx.fillRect(0, j * rh - 2, w, 3); }
  }, true);
}
// Prédio: caixa com janelas nas laterais (acendem à noite) e laje no topo.
function buildingMesh(items, W, H, D, wall, glass) {
  const floors = Math.max(1, Math.round(H / 3.2)), bays = Math.max(2, Math.round(W / 3.6));
  const tex = windowTex(wall, glass, false, 4, 4), lit = windowTex(wall, glass, true, 4, 4);
  tex.repeat.set(bays / 4, floors / 4); lit.repeat.copy(tex.repeat);
  const side = new THREE.MeshLambertMaterial({ map: tex, emissiveMap: lit, emissive: new THREE.Color(0, 0, 0) });
  const roof = lam(new THREE.Color(wall).multiplyScalar(.6));
  const geo = new THREE.BoxGeometry(W, H, D); geo.translate(0, H / 2, 0);
  const mesh = scroller(geo, [side, side, roof, roof, side, side], items, false, 'lote');
  (R.cityWindows = R.cityWindows || []).push(side);
  return mesh;
}
// Casa térrea: paredes, telhado de quatro águas, porta e janelas (cores por vértice).
function houseGeo() {
  const wall = C('#ffffff'), roof = C('#a2492e'), dark = C('#3a2a22'), glass = C('#2a3b4a');
  const part = (g, c) => ({ geo: g, color: () => c });
  const body = new THREE.BoxGeometry(8, 3.2, 9); body.translate(0, 1.6, 0);
  const top = new THREE.ConeGeometry(7.2, 2.4, 4); top.rotateY(Math.PI / 4); top.scale(1, 1, 1.15); top.translate(0, 4.4, 0);
  const door = new THREE.BoxGeometry(.1, 2.1, 1.1); door.translate(-4.02, 1.05, 0);
  const w1 = new THREE.BoxGeometry(.1, 1.1, 1.6); w1.translate(-4.02, 1.8, -2.8);
  const w2 = new THREE.BoxGeometry(.1, 1.1, 1.6); w2.translate(-4.02, 1.8, 2.8);
  return mergeParts([part(body, wall), part(top, roof), part(door, dark), part(w1, glass), part(w2, glass)]);
}

function buildCity() {
  const r = rng(404);
  const bothSides = (x, z, extra = {}) => [{ x, z, ...extra }, { x: -x, z, ry: Math.PI, ...extra }];
  // calçadas e meio-fio
  const slabs = [], curbs = [];
  for (let z = Z_FAR; z < Z_BACK; z += 4) for (const s of [-1, 1]) { slabs.push({ x: s * 8.4, y: .08, z }); curbs.push({ x: s * 6.62, y: .1, z }); }
  scroller(new THREE.BoxGeometry(3.4, .16, 4.02), lam('#b7b3a9'), slabs, false, 'city');
  scroller(new THREE.BoxGeometry(.24, .2, 4.02), lam('#dad6cd'), curbs, false, 'city');

  // terrenos: piso urbano atrás das calçadas (cobre a grama)
  const lots = [];
  for (let z = Z_FAR; z < Z_BACK; z += 20) for (const s of [-1, 1]) lots.push({ x: s * 40, y: .02, z });
  scroller(new THREE.BoxGeometry(62, .04, 20.05), lam('#8f8a80'), lots, false, 'city');

  // quadras: casas na frente, prédios atrás
  const houses = [], shops = [], towersA = [], towersB = [], towersC = [], towersD = [], parks = [];
  const tint = () => new THREE.Color().setHSL(r(), .35 + r() * .25, .78 + r() * .12);
  for (const s of [-1, 1]) {
    for (let z = Z_FAR + 8; z < Z_BACK - 8; z += 14 + r() * 4) {
      if (nearCross(z)) continue;
      const roll = r();
      if (roll < .5) houses.push({ x: s * 16.5, y: 0, z, ry: s > 0 ? 0 : Math.PI, color: tint() });
      else if (roll < .82) shops.push({ x: s * 17.5, y: 0, z, ry: s > 0 ? 0 : Math.PI });
      else parks.push({ x: s * (14 + r() * 4), y: 0, z, sx: .65, sy: .65, sz: .65, ry: r() * 6, color: new THREE.Color(1, 1, 1) });
    }
    for (let z = Z_FAR + 12; z < Z_BACK - 12; z += 22 + r() * 8) {
      if (nearCross(z)) continue;
      const list = [towersA, towersB, towersC, towersD][Math.floor(r() * 4)];
      list.push({ x: s * (34 + r() * 10), y: 0, z, ry: (r() < .5 ? 0 : Math.PI / 2) });
    }
  }
  scroller(houseGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), houses, false, 'lote');
  buildingMesh(shops, 9, 7, 12, '#e3d5bd', '#33475a');       // comércio baixo
  buildingMesh(towersA, 16, 30, 14, '#cbbfae', '#2f4252');   // residencial
  buildingMesh(towersB, 13, 22, 13, '#9fb3c4', '#1f3346');   // escritório envidraçado
  buildingMesh(towersC, 18, 14, 13, '#d9cdb9', '#3b4c5c');   // bloco médio
  buildingMesh(towersD, 11, 42, 11, '#b8bcc1', '#26384a');   // torre alta
  const G = buildTreeGeos(), treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  scroller(G.broad, treeMat, parks, false, 'lote');
  // árvores de rua na calçada
  const street = [];
  for (let z = Z_FAR + 10; z < Z_BACK; z += 26) for (const s of [-1, 1]) if (!nearCross(z)) street.push({ x: s * 9.6, y: 0, z: z + s * 6, sx: .55, sy: .6, sz: .55, ry: r() * 6, color: new THREE.Color(1, 1, 1) });
  scroller(G.broad, treeMat, street, false, 'city');

  // postes de iluminação (a luminária acende à noite)
  const lp = [], la = [], lh = [];
  for (let z = Z_FAR; z < Z_BACK; z += 32) for (const s of [-1, 1]) {
    const zz = z + (s > 0 ? 0 : 16);
    lp.push({ x: s * 7.0, y: 4, z: zz }); la.push({ x: s * 6.1, y: 7.9, z: zz }); lh.push({ x: s * 5.2, y: 7.8, z: zz });
  }
  scroller(new THREE.CylinderGeometry(.08, .12, 8, 6), lam('#6f757b'), lp, true, 'city');
  scroller(new THREE.BoxGeometry(1.9, .08, .1), lam('#6f757b'), la, false, 'city');
  R.lampHeads = new THREE.MeshBasicMaterial({ color: 0x3a3d40 });
  scroller(new THREE.BoxGeometry(.7, .14, .32), R.lampHeads, lh, false, 'city');

  // cruzamentos: rua transversal, faixa de pedestres e semáforos (sempre verdes)
  const cross = [], zebra = [], tPole = [], tArm = [], tHead = [], tGreen = [], tOff = [];
  for (const o of V.CROSSINGS) {
    const z = zOfS(o);
    for (const s of [-1, 1]) cross.push({ x: s * 37, y: .03, z });
    for (let i = 0; i < 15; i++) zebra.push({ x: -10.7 + i, y: .015, z: z + 7.5, fixo: true }); // atravessa as quatro faixas
    // semáforo do nosso sentido (lado direito, antes do cruzamento, de frente para o motorista)
    tPole.push({ x: 7.0, y: 2.9, z: z + 9.5 }); tArm.push({ x: 4.7, y: 5.6, z: z + 9.5 }); tHead.push({ x: 2.4, y: 5.1, z: z + 9.5 });
    tGreen.push({ x: 2.4, y: 4.75, z: z + 9.69 });
    tOff.push({ x: 2.4, y: 5.45, z: z + 9.69 }, { x: 2.4, y: 5.1, z: z + 9.69 });
    // semáforo do sentido oposto (vemos o verso)
    tPole.push({ x: -7.0, y: 2.9, z: z - 9.5 }); tArm.push({ x: -4.7, y: 5.6, z: z - 9.5 }); tHead.push({ x: -2.4, y: 5.1, z: z - 9.5 });
  }
  scroller(new THREE.BoxGeometry(60, .04, 9), lam('#4a4d50'), cross, false, 'city');
  scroller(new THREE.BoxGeometry(.5, .01, 3), lam('#e8e8e2'), zebra, false, 'city');
  scroller(new THREE.CylinderGeometry(.1, .12, 5.8, 6), lam('#3b3f44'), tPole, true, 'city');
  scroller(new THREE.BoxGeometry(4.6, .14, .14), lam('#3b3f44'), tArm, false, 'city');
  scroller(new THREE.BoxGeometry(.42, 1.15, .34), lam('#1a1c1e'), tHead, false, 'city');
  scroller(new THREE.CircleGeometry(.13, 12), new THREE.MeshBasicMaterial({ color: 0x23ff6a }), tGreen, false, 'city');
  scroller(new THREE.CircleGeometry(.13, 12), lam('#2a1414'), tOff, false, 'city');
}

/* ---------- cartões-postais de Matipó ----------
 * Três lugares da cidade, modelados a partir das fotos de referência, que aparecem ao entrar em
 * Matipó (world.postais, posições em core.js): a Igreja Matriz (neogótica, torre central com
 * relógio e flecha azul, vitrais, janelas ogivais com moldura dourada e cúpula azul nos fundos), a
 * Praça do Café (praça redonda com palco circular de mosaico, canteiros floridos, parquinho e
 * pérgola, sem letreiro) e o centro acadêmico da Univertix (prédios azuis com placas solares no telhado em volta
 * de uma rotunda branca com cúpula de vidro azul listrada, e quadra poliesportiva).
 * Cada um é montado num referencial próprio: x ao longo da via, z para a via (a fachada olha para
 * +z) e u = -z a distância a partir da borda externa da calçada. O grupo é girado para o lado em
 * que fica (direita: fachada para -x; esquerda: para +x), e o lote dele, de POSTAL_MEIO para cada
 * lado, fica livre de casas e prédios genéricos (veja o "lote reservado" no shader do cenário). */
const CALCADA_FIM = 10.1; // borda externa da calçada direita (m); a esquerda fica ESQ além
// Iluminação noturna dos cartões-postais: cresce junto com a noite (env.night), como as janelas da
// cidade. noite(material, cor, força) acende o material; brilho(...) põe um halo nos postes.
const NOITE = { mats: [], halos: [] };
function noite(mat, cor, forca) { NOITE.mats.push({ mat, cor: new THREE.Color(cor), forca }); return mat; }
function malha(g, geo, mat, x, y, z, o = {}) {
  const m = new THREE.Mesh(geo, typeof mat === 'string' ? lam(mat) : mat);
  m.position.set(x, y, z);
  if (o.rx) m.rotation.x = o.rx; if (o.ry) m.rotation.y = o.ry; if (o.rz) m.rotation.z = o.rz;
  m.castShadow = o.sombra !== false; m.receiveShadow = true;
  g.add(m); return m;
}
// caixa com a base em y
const bloco = (g, w, h, d, mat, x, y, z, o) => malha(g, new THREE.BoxGeometry(w, h, d), mat, x, y + h / 2, z, o);
// Arco ogival (gótico, de raio igual à largura): base em y = 0, topo em y = h.
function ogiva(w, h) {
  const s = new THREE.Shape(), ys = h - w * .866;
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, ys);
  s.absarc(-w / 2, ys, w, 0, Math.PI / 3, false);
  s.absarc(w / 2, ys, w, Math.PI * 2 / 3, Math.PI, false);
  s.lineTo(-w / 2, 0);
  return s;
}
// Janela ogival com moldura, numa parede que olha para +z (ry gira para outra parede).
function janelaOgival(g, w, h, x, y, z, vidro, moldura, ry = 0) {
  const p = new THREE.Group(); p.position.set(x, y, z); p.rotation.y = ry; g.add(p);
  const f = new THREE.Mesh(new THREE.ShapeGeometry(ogiva(w + .36, h + .3)), moldura); f.position.set(0, -.15, .02); p.add(f);
  const v = new THREE.Mesh(new THREE.ShapeGeometry(ogiva(w, h)), vidro); v.position.z = .04; p.add(v);
  return p;
}
function relogioTex() {
  return canvasTex(256, 256, (c, w) => {
    const r = w / 2;
    c.fillStyle = '#d6b04c'; c.beginPath(); c.arc(r, r, r, 0, 7); c.fill();
    c.fillStyle = '#f7f4ea'; c.beginPath(); c.arc(r, r, r * .86, 0, 7); c.fill();
    c.strokeStyle = '#1d2a3a'; c.lineCap = 'round';
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; c.lineWidth = i % 3 ? 5 : 10; c.beginPath(); c.moveTo(r + Math.cos(a) * r * .62, r + Math.sin(a) * r * .62); c.lineTo(r + Math.cos(a) * r * .78, r + Math.sin(a) * r * .78); c.stroke(); }
    const ponteiro = (a, l, lw) => { c.lineWidth = lw; c.beginPath(); c.moveTo(r, r); c.lineTo(r + Math.cos(a) * l, r + Math.sin(a) * l); c.stroke(); };
    ponteiro(-Math.PI / 2 - Math.PI / 6 * 2, r * .42, 10); ponteiro(-Math.PI / 2 + Math.PI / 6 * 2, r * .62, 7); // 10h10
    c.fillStyle = '#1d2a3a'; c.beginPath(); c.arc(r, r, 10, 0, 7); c.fill();
  });
}
function vitralTex() {
  return canvasTex(128, 512, (c, w, h) => {
    c.fillStyle = '#16264a'; c.fillRect(0, 0, w, h);
    const r = rng(41), cores = ['#2f5fb4', '#c2382d', '#e0b43a', '#3c8a5a', '#6a3fa0', '#4aa3d8'];
    for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { c.fillStyle = cores[Math.floor(r() * cores.length)]; c.globalAlpha = .45 + r() * .4; c.fillRect(x + 2, y + 2, 12, 12); }
    c.globalAlpha = 1; c.strokeStyle = '#0b1220'; c.lineWidth = 3;
    for (let y = 0; y <= h; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.stroke();
  });
}
function textoTex(texto, { fundo = '#ffffff', cor = '#123a7a', fonte = 'Arial', peso = 900, w = 1024, h = 192, borda = null } = {}) {
  return canvasTex(w, h, (c) => {
    c.fillStyle = fundo; c.fillRect(0, 0, w, h);
    if (borda) { c.strokeStyle = borda; c.lineWidth = h * .06; c.strokeRect(h * .05, h * .05, w - h * .1, h - h * .1); }
    let fs = h * .62; c.font = `${peso} ${fs}px ${fonte}`;
    while (c.measureText(texto).width > w * .9) { fs *= .92; c.font = `${peso} ${fs}px ${fonte}`; }
    c.fillStyle = cor; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(texto, w / 2, h / 2 + h * .03);
  });
}
// Palmeira: tronco anelado e folhas arqueadas.
function palmeira(g, x, z, h = 6.5) {
  malha(g, new THREE.CylinderGeometry(.16, .26, h, 7), '#8d8170', x, h / 2, z);
  const folha = new THREE.ConeGeometry(.35, 3.6, 4); folha.rotateX(Math.PI / 2); folha.translate(0, 0, 1.8); folha.scale(1, .25, 1);
  const verde = lam('#4f7d32');
  for (let i = 0; i < 9; i++) {
    const p = new THREE.Group(); p.position.set(x, h, z); p.rotation.y = i * Math.PI * 2 / 9; g.add(p);
    const f = new THREE.Mesh(folha, verde); f.rotation.x = .45 + (i % 2) * .25; f.castShadow = true; p.add(f);
  }
}
function arvore(g, G, x, z, s = 1, tipo = 'broad') {
  const m = new THREE.Mesh(G[tipo], R.postalArvoreMat); m.position.set(x, 0, z); m.scale.setScalar(s); m.rotation.y = x * 1.7 + z; m.castShadow = true; g.add(m);
}
function banco(g, x, z, ry = 0) {
  const p = new THREE.Group(); p.position.set(x, 0, z); p.rotation.y = ry; g.add(p);
  bloco(p, 1.8, .08, .5, '#8a6a4a', 0, .45, 0); bloco(p, 1.8, .45, .08, '#8a6a4a', 0, .55, -.22);
  for (const s of [-.75, .75]) bloco(p, .08, .45, .45, '#3b3f44', s, 0, 0);
}
function poste(g, x, z, h = 4.5) {
  malha(g, new THREE.CylinderGeometry(.06, .08, h, 6), '#3b3f44', x, h / 2, z, { sombra: false });
  malha(g, new THREE.SphereGeometry(.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0xf3efe0 }), x, h + .1, z, { sombra: false });
  const halo = glowSprite(0xffdc9a, 3.2); halo.position.set(x, h + .1, z); halo.material.opacity = 0; g.add(halo); NOITE.halos.push(halo);
}

/* Igreja Matriz: fachada em z = -11 (11 m depois da calçada, com o adro na frente), nave até z = -50. */
function igrejaMatipo(G) {
  const g = new THREE.Group();
  const parede = lam('#e4e9ef'), pedra = lam('#b9b2a6'), azul = lam('#2f6db5'), azulClaro = lam('#8ab4e0'),
    ouro = std('#d6b04c', { metalness: .5, roughness: .35 }), vidro = std('#1c2c4a', { metalness: .4, roughness: .2 }),
    telha = lam('#a9785a'), madeira = lam('#4a3020');
  // à noite: refletores nas paredes (luz quente) e as janelas acesas por dentro
  noite(parede, '#ffd9a0', .32); noite(azulClaro, '#ffd9a0', .22); noite(ouro, '#ffcf70', .35); noite(vidro, '#ffbf55', .95); noite(pedra, '#ffd9a0', .2);
  const F = -11, nave = { w: 15, h: 13, d: 38 };
  // adro: piso, canteiros com mureta de pedra, palmeiras, árvores e bancos
  bloco(g, 36, .08, 11, '#c9c2b4', 0, 0, F / 2, { sombra: false });
  for (const s of [-1, 1]) {
    bloco(g, 9, .5, 5, pedra, s * 12, 0, F + 4.5); bloco(g, 8.6, .06, 4.6, '#5f8f3c', s * 12, .5, F + 4.5, { sombra: false });
    palmeira(g, s * 12, F + 4.5, 7); arvore(g, G, s * 16.5, -3, .9);
    banco(g, s * 6.5, -2.2, Math.PI);
  }
  poste(g, -3, -1.2); poste(g, 3, -1.2);
  // escadaria
  for (let i = 0; i < 3; i++) bloco(g, 10 - i * 1.2, .18, 3 - i * .9, pedra, 0, i * .18, F + 2.7 - i * .45);
  // nave: rodapé de pedra, paredes, cornija azul e telhado de duas águas
  const nz = F - nave.d / 2;
  bloco(g, nave.w + .3, 1.2, nave.d + .3, pedra, 0, 0, nz);
  bloco(g, nave.w, nave.h, nave.d, parede, 0, 0, nz);
  bloco(g, nave.w + .5, .35, nave.d + .5, azulClaro, 0, nave.h, nz);
  const tri = new THREE.Shape(); tri.moveTo(-nave.w / 2 - .5, 0); tri.lineTo(nave.w / 2 + .5, 0); tri.lineTo(0, 5.2); tri.lineTo(-nave.w / 2 - .5, 0);
  const tg = new THREE.ExtrudeGeometry(tri, { depth: nave.d + .6, bevelEnabled: false }); tg.translate(0, 0, -(nave.d + .6) / 2);
  malha(g, tg, telha, 0, nave.h + .35, nz);
  // frontão da nave (empena) atrás da torre
  const emp = new THREE.ShapeGeometry(tri); malha(g, emp, parede, 0, nave.h + .35, F + .02, { sombra: false });
  // laterais: pilastras azul-claro com pináculos dourados e janelas ogivais com moldura dourada
  for (const s of [-1, 1]) {
    for (let i = 0; i <= 6; i++) {
      const z = F - 1 - i * (nave.d - 2) / 6;
      bloco(g, .5, nave.h, .7, azulClaro, s * (nave.w / 2 + .2), 0, z);
      malha(g, new THREE.ConeGeometry(.28, 1.4, 6), ouro, s * (nave.w / 2 + .2), nave.h + 1.05, z);
      if (i < 6) {
        const zj = z - (nave.d - 2) / 12;
        janelaOgival(g, 1.5, 5.2, s * (nave.w / 2 + .01), 3.2, zj, vidro, ouro, s * Math.PI / 2);
        malha(g, new THREE.CircleGeometry(.6, 16), ouro, s * (nave.w / 2 + .03), 10.4, zj, { ry: s * Math.PI / 2, sombra: false });
        malha(g, new THREE.CircleGeometry(.45, 16), vidro, s * (nave.w / 2 + .06), 10.4, zj, { ry: s * Math.PI / 2, sombra: false });
      }
    }
  }
  // fachada da nave, dos dois lados da torre: óculo dourado e janela ogival
  for (const s of [-1, 1]) {
    malha(g, new THREE.CircleGeometry(.95, 20), ouro, s * 5.5, 8.6, F + .03, { sombra: false });
    malha(g, new THREE.CircleGeometry(.7, 20), vidro, s * 5.5, 8.6, F + .05, { sombra: false });
    janelaOgival(g, 1.3, 3.8, s * 5.5, 2.2, F + .02, vidro, ouro);
    malha(g, new THREE.ConeGeometry(.3, 1.6, 6), ouro, s * (nave.w / 2 - .3), nave.h + 1.2, F);
  }
  // torre central, saliente: corpo, campanário com arcadas azuis, andar do relógio, pináculos e flecha
  const T = { w: 6.6, z: F + 1.2 };
  bloco(g, T.w + .3, 1.2, T.w + .3, pedra, 0, 0, T.z - T.w / 2);
  bloco(g, T.w, 21, T.w, parede, 0, 0, T.z - T.w / 2);
  for (const s of [-1, 1]) bloco(g, .45, 21, .45, azulClaro, s * (T.w / 2 - .05), 0, T.z - .05); // quinas
  // porta principal (ogival, madeira) com moldura azul e dourada
  janelaOgival(g, 2.6, 4.6, 0, 1.2, T.z + .02, madeira, azul);
  malha(g, new THREE.ShapeGeometry(ogiva(3.3, 5.1)), ouro, 0, 1.0, T.z + .01, { sombra: false });
  // vitral alto sobre a porta
  bloco(g, 2.2, 9.6, .1, azul, 0, 7.4, T.z + .02, { sombra: false });
  const vt = vitralTex(), vitral = new THREE.MeshLambertMaterial({ map: vt, emissiveMap: vt }); noite(vitral, '#ffffff', 1.1);
  malha(g, new THREE.PlaneGeometry(1.6, 9), vitral, 0, 12.2, T.z + .09, { sombra: false });
  // campanário: arcadas nas quatro faces
  bloco(g, T.w + .4, .4, T.w + .4, azulClaro, 0, 21, T.z - T.w / 2);
  bloco(g, T.w, 4, T.w, parede, 0, 21.4, T.z - T.w / 2);
  for (let f = 0; f < 4; f++) {
    const a = f * Math.PI / 2, cx = Math.sin(a) * (T.w / 2 + .02), cz = T.z - T.w / 2 + Math.cos(a) * (T.w / 2 + .02);
    for (const k of [-1.6, 0, 1.6]) {
      const ox = Math.cos(a) * k, oz = -Math.sin(a) * k;
      janelaOgival(g, .9, 2.8, cx + ox, 21.9, cz + oz, lam('#1a2230'), azul, a);
    }
  }
  // andar do relógio: relógios nas quatro faces, cornijas e pináculos nos cantos
  bloco(g, T.w + .5, .4, T.w + .5, azulClaro, 0, 25.4, T.z - T.w / 2);
  bloco(g, T.w - .4, 3.6, T.w - .4, parede, 0, 25.8, T.z - T.w / 2);
  const rt = relogioTex(), relogio = new THREE.MeshLambertMaterial({ map: rt, emissiveMap: rt }); noite(relogio, '#ffffff', .95);
  for (let f = 0; f < 4; f++) {
    const a = f * Math.PI / 2, r = (T.w - .4) / 2 + .03;
    malha(g, new THREE.CircleGeometry(1.25, 28), relogio, Math.sin(a) * r, 27.6, T.z - T.w / 2 + Math.cos(a) * r, { ry: a, sombra: false });
  }
  bloco(g, T.w + .2, .35, T.w + .2, azulClaro, 0, 29.4, T.z - T.w / 2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) malha(g, new THREE.ConeGeometry(.32, 2.2, 6), ouro, sx * (T.w / 2 - .1), 30.6, T.z - T.w / 2 + sz * (T.w / 2 - .1));
  // flecha octogonal azul-clara e cruz dourada
  malha(g, new THREE.ConeGeometry(T.w / 2 - .2, 13, 8), noite(std('#a9c8ea', { roughness: .45 }), '#bcd8ff', .4), 0, 29.75 + 6.5, T.z - T.w / 2, { ry: Math.PI / 8 });
  bloco(g, .12, 1.6, .12, ouro, 0, 42.6, T.z - T.w / 2); bloco(g, .9, .12, .12, ouro, 0, 43.5, T.z - T.w / 2);
  // cúpula azul nos fundos, sobre um tambor, com lanternim e cruz
  const cz = F - nave.d + 3;
  malha(g, new THREE.CylinderGeometry(4.2, 4.4, 3, 20), parede, 0, nave.h + 1.5, cz);
  malha(g, new THREE.SphereGeometry(4.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), noite(std('#7fb2e5', { metalness: .25, roughness: .35 }), '#9cc8ff', .4), 0, nave.h + 3, cz);
  malha(g, new THREE.CylinderGeometry(.6, .7, 1.4, 10), parede, 0, nave.h + 7.8, cz);
  bloco(g, .1, 1.4, .1, ouro, 0, nave.h + 8.5, cz); bloco(g, .7, .1, .1, ouro, 0, nave.h + 9.4, cz);
  return g;
}

/* Praça do Café: centro a 25 m da calçada; palco circular de mosaico, canteiros floridos em anel,
 * parquinho de pisos coloridos, pérgola moderna ao fundo, árvores, bancos e postes. */
function pracaDoCafe(G) {
  const g = new THREE.Group(), C0 = -25;
  const piso = canvasTex(512, 512, (c, w, h) => { noiseFill(c, w, h, [190, 181, 165], 18, 31); c.strokeStyle = 'rgba(120,110,95,.25)'; c.lineWidth = 2; for (let i = 0; i <= w; i += 32) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, h); c.stroke(); c.beginPath(); c.moveTo(0, i); c.lineTo(w, i); c.stroke(); } }, true);
  piso.repeat.set(6, 6);
  malha(g, new THREE.CylinderGeometry(24, 24, .1, 64), new THREE.MeshLambertMaterial({ map: piso }), 0, .05, C0, { sombra: false });
  // calçadão da frente até a calçada da rua
  bloco(g, 10, .1, 3, new THREE.MeshLambertMaterial({ map: piso }), 0, 0, -1.5, { sombra: false });
  // palco circular com mosaico de folhas e estrelas
  const mosaico = canvasTex(512, 512, (c, w) => {
    const r = w / 2; c.fillStyle = '#d9d2c3'; c.fillRect(0, 0, w, w);
    c.fillStyle = '#9b8f7c';
    for (let i = 0; i < 9; i++) { const a = i * Math.PI * 2 / 9, d = r * (.25 + (i % 3) * .2); c.save(); c.translate(r + Math.cos(a) * d, r + Math.sin(a) * d); c.rotate(a * 1.7);
      c.beginPath(); for (let k = 0; k < 10; k++) { const rr = k % 2 ? 9 : 26, aa = k * Math.PI / 5; c.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr); } c.closePath(); c.fill(); c.restore(); }
    c.strokeStyle = '#b3a892'; c.lineWidth = 6; c.beginPath(); c.arc(r, r, r * .92, 0, 7); c.stroke();
  });
  const palco = new THREE.MeshLambertMaterial({ map: mosaico }); noite(palco, '#ffe2b0', .28);
  malha(g, new THREE.CylinderGeometry(8.5, 8.7, .9, 48), [noite(lam('#cfc9bd'), '#ffe2b0', .25), palco, lam('#cfc9bd')], 0, .45, C0);
  // canteiros em anel: grama com flores vermelhas, em cinco arcos (passagens entre eles)
  const canteiro = canvasTex(512, 128, (c, w, h) => { c.fillStyle = '#4f8a35'; c.fillRect(0, 0, w, h); const r = rng(5); for (let i = 0; i < 900; i++) { c.fillStyle = r() < .55 ? '#d22b2b' : r() < .5 ? '#f05a3a' : '#7fbf4a'; c.fillRect(r() * w, r() * h, 3, 3); } }, true);
  for (let i = 0; i < 5; i++) {
    const ini = i * Math.PI * 2 / 5 + .12, comp = Math.PI * 2 / 5 - .24;
    malha(g, new THREE.CylinderGeometry(15, 15, .35, 24, 1, false, ini, comp), [lam('#e3ddd0'), new THREE.MeshLambertMaterial({ map: canteiro }), lam('#e3ddd0')], 0, .2, C0, { sombra: false });
    malha(g, new THREE.CylinderGeometry(11.5, 11.5, .36, 24, 1, false, ini, comp), lam('#d6d0c3'), 0, .2, C0, { sombra: false }); // piso entre o palco e o canteiro
  }
  // parquinho: pisos azul e amarelo, escorregador e gangorra
  malha(g, new THREE.CylinderGeometry(2.6, 2.6, .06, 28), lam('#2f6fd0'), -17, .12, C0 + 10, { sombra: false });
  malha(g, new THREE.CylinderGeometry(3, 3, .06, 28), lam('#f2c12e'), -13, .12, C0 + 14.5, { sombra: false });
  bloco(g, .5, 1.8, .5, '#d23a33', -13, .1, C0 + 13); malha(g, new THREE.BoxGeometry(.6, .06, 3), lam('#2f8f5a'), -13, 1.0, C0 + 14.6, { rx: -.55 });
  bloco(g, 2.6, .08, .25, '#2f6fd0', -17, .7, C0 + 10, { rz: .2 }); bloco(g, .2, .6, .2, '#3b3f44', -17, .1, C0 + 10);
  // árvores em volta e bancos voltados para o palco
  for (let i = 0; i < 9; i++) { const a = i * Math.PI * 2 / 9 + .3, d = 19.5 + (i % 2) * 2; if (Math.cos(a) > .85) continue; arvore(g, G, Math.sin(a) * d, C0 + Math.cos(a) * d, .85 + (i % 3) * .12, i % 3 ? 'broad' : 'tall'); }
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + .5, d = 10.3; banco(g, Math.sin(a) * d, C0 + Math.cos(a) * d, a + Math.PI); }
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3, d = 23; poste(g, Math.sin(a) * d, C0 + Math.cos(a) * d, 5); }
  // pérgola moderna ao fundo: pórtico grafite com cobertura e telão
  const P = C0 - 18;
  for (const s of [-1, 1]) bloco(g, .8, 7.5, .8, '#33373d', s * 7, 0, P);
  bloco(g, 15, .9, 1.4, '#33373d', 0, 7.5, P);
  bloco(g, 14, .2, 6, noite(std('#d9dde2', { metalness: .3, roughness: .4 }), '#fff2d0', .8), 0, 6.6, P - 2.5); // cobertura com LED
  bloco(g, 9, 3.6, .3, noite(std('#1d2f45', { metalness: .2, roughness: .3 }), '#4f8fe0', .7), 0, 1.6, P - 4.5); // telão aceso
  return g;
}

/* Centro acadêmico da Univertix: três prédios azuis com quinas cor de tijolo e placas solares no
 * telhado em volta de uma rotunda branca com cúpula de vidro azul listrada; letreiro, quadra e
 * ciprestes. Frente a 4 m da calçada, com estacionamento. */
function univertix(G) {
  const g = new THREE.Group();
  const fachada = (andares, colunas) => {
    const t = canvasTex(256, 256, (c, w, h) => {
      c.fillStyle = '#2c5aa8'; c.fillRect(0, 0, w, h);
      const cw = w / 4, rh = h / 4;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { c.fillStyle = '#cfe3f4'; c.fillRect(i * cw + cw * .12, j * rh + rh * .3, cw * .76, rh * .42); c.fillStyle = '#7fa9cf'; c.fillRect(i * cw + cw * .12, j * rh + rh * .3, cw * .76, rh * .08); }
      c.fillStyle = '#e8eef4'; for (let j = 0; j < 4; j++) c.fillRect(0, j * rh + rh * .82, w, rh * .1);
    }, true);
    t.repeat.set(colunas / 4, andares / 4);
    // à noite: as janelas acendem (como as da cidade, em R.cityWindows)
    const aceso = canvasTex(256, 256, (c, w, h) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      const cw = w / 4, rh = h / 4, r = rng(colunas * 7 + andares);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { c.fillStyle = r() < .7 ? '#ffe3a8' : '#3a3020'; c.fillRect(i * cw + cw * .12, j * rh + rh * .3, cw * .76, rh * .42); }
    }, true);
    aceso.repeat.copy(t.repeat);
    const m = new THREE.MeshLambertMaterial({ map: t, emissiveMap: aceso, emissive: new THREE.Color(0, 0, 0) });
    (R.cityWindows = R.cityWindows || []).push(m);
    return m;
  };
  const solar = canvasTex(256, 256, (c, w, h) => { c.fillStyle = '#1b2d55'; c.fillRect(0, 0, w, h); c.strokeStyle = '#9fb2c8'; c.lineWidth = 2; for (let i = 0; i <= w; i += 32) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, h); c.stroke(); } for (let j = 0; j <= h; j += 18) { c.beginPath(); c.moveTo(0, j); c.lineTo(w, j); c.stroke(); } }, true);
  const tijolo = lam('#b4532a');
  // prédio azul (w ao longo de x, d em z), centro (x, z), girado ry
  const predio = (x, z, w, d, h, ry) => {
    const p = new THREE.Group(); p.position.set(x, 0, z); p.rotation.y = ry; g.add(p);
    const lado = fachada(Math.round(h / 3.3), Math.round(d / 3)), frente = fachada(Math.round(h / 3.3), Math.round(w / 3));
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [lado, lado, lam('#d7dbe0'), lam('#d7dbe0'), frente, frente]);
    m.position.y = h / 2; m.castShadow = m.receiveShadow = true; p.add(m);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bloco(p, .8, h + .3, .8, tijolo, sx * (w / 2 - .3), 0, sz * (d / 2 - .3));
    bloco(p, w + .4, .5, d + .4, '#e8ecf0', 0, h, 0); // platibanda
    const st = solar.clone(); st.needsUpdate = true; st.repeat.set(w / 6, d / 4);
    for (const s of [-1, 1]) malha(p, new THREE.PlaneGeometry(w - 1.2, d / 2 - .8), std('#ffffff', { map: st, metalness: .5, roughness: .25 }), 0, h + .9, s * d / 4, { rx: -Math.PI / 2 + s * .18, sombra: false });
    return p;
  };
  const RZ = -27; // centro da rotunda
  predio(-16, RZ + 1, 12, 26, 14, 0);
  predio(16, RZ - 2, 12, 26, 14, -.35);
  predio(0, RZ - 22, 28, 12, 18, 0);
  // Rotunda branca com sacadas, na altura dos prédios (ROT.h), e a cúpula de vidro azul listrada por
  // cima deles, como na foto: o globo é o ponto mais alto do conjunto.
  const ROT = { r: 7, h: 15, domo: 6.4 };
  malha(g, new THREE.CylinderGeometry(ROT.r, ROT.r, ROT.h, 32), noite(lam('#eef0f2'), '#fff0d8', .3), 0, ROT.h / 2, RZ);
  for (let y = 3; y <= ROT.h; y += 3) malha(g, new THREE.CylinderGeometry(ROT.r + .5, ROT.r + .5, .3, 32), lam('#c9ced4'), 0, y, RZ);
  const janelaRot = noite(std('#2b4566', { metalness: .4, roughness: .2 }), '#ffd99a', .85);
  for (let andar = 0; andar < ROT.h / 3; andar++) for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    malha(g, new THREE.PlaneGeometry(1.6, 1.9), janelaRot, Math.sin(a) * (ROT.r + .02), andar * 3 + 1.55, RZ + Math.cos(a) * (ROT.r + .02), { ry: a, sombra: false });
  }
  const topo = ROT.h + 1.8; // tambor sob a cúpula
  malha(g, new THREE.CylinderGeometry(ROT.domo, ROT.domo + .4, 1.8, 32), lam('#f4f5f6'), 0, ROT.h + .9, RZ);
  const listras = canvasTex(512, 64, (c, w, h) => { for (let i = 0; i < 32; i++) { c.fillStyle = i % 2 ? '#1f5fb8' : '#3f86d8'; c.fillRect(i * w / 32, 0, w / 32, h); } c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(0, 0, w, h * .25); });
  malha(g, new THREE.SphereGeometry(ROT.domo, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), noite(std('#ffffff', { map: listras, emissiveMap: listras, metalness: .45, roughness: .18 }), '#ffffff', .6), 0, topo, RZ);
  malha(g, new THREE.SphereGeometry(.55, 12, 8), lam('#f4f5f6'), 0, topo + ROT.domo + .3, RZ);
  // letreiro na fachada do prédio da esquerda, de frente para a rua (o dos fundos fica atrás da
  // rotunda), e um totem junto à rua
  const nome = new THREE.MeshBasicMaterial({ map: textoTex('UNIVERTIX', { fundo: '#f4f6f8', cor: '#173f8a' }) });
  malha(g, new THREE.PlaneGeometry(10, 1.9), nome, -16, 11.6, RZ + 1 + 13 + .45, { sombra: false });
  bloco(g, 1.2, 4.2, 2.8, '#173f8a', 11, 0, -2.5);
  malha(g, new THREE.PlaneGeometry(4, .9), new THREE.MeshBasicMaterial({ map: textoTex('UNIVERTIX', { fundo: '#173f8a', cor: '#ffffff' }) }), 11.61, 3.2, -2.5, { ry: Math.PI / 2, sombra: false });
  // estacionamento, ciprestes e quadra poliesportiva azul
  bloco(g, 50, .06, 9, '#5d6166', 0, 0, -5.5, { sombra: false });
  for (let i = -3; i <= 3; i++) bloco(g, .12, .07, 4, '#e6e6e0', i * 6, 0, -6, { sombra: false });
  for (const x of [-7.5, -5, 5, 7.5]) malha(g, new THREE.ConeGeometry(.9, 7, 8), lam('#2f5a2c'), x, 3.5, RZ + 9);
  bloco(g, 13, .08, 22, '#2a64b8', 36, .04, RZ - 4, { sombra: false });
  bloco(g, 10, .09, 18, '#c8573a', 36, .04, RZ - 4, { sombra: false });
  for (const z of [RZ - 13, RZ - 4, RZ + 5]) bloco(g, 10, .1, .1, '#ffffff', 36, .04, z, { sombra: false });
  arvore(g, G, -27, -8, 1); arvore(g, G, 26, -9, .9);
  return g;
}
// Piso do lote inteiro e uma fileira de prédios ao fundo (o lote reservado tira os genéricos daquele
// lado; sem isto, atrás do cartão-postal apareceria o campo).
function loteUrbano(g, fundo, seed) {
  bloco(g, 2 * V.POSTAL_MEIO, .02, 95, '#8f8a80', 0, .03, -47.5, { sombra: false });
  const r = rng(seed), cores = [['#cbbfae', '#2f4252'], ['#9fb3c4', '#1f3346'], ['#d9cdb9', '#3b4c5c'], ['#b8bcc1', '#26384a'], ['#e3d5bd', '#33475a']];
  for (let x = -V.POSTAL_MEIO + 8; x < V.POSTAL_MEIO - 8; x += 15 + r() * 6) {
    const [parede, vidro] = cores[Math.floor(r() * cores.length)], w = 11 + r() * 5, h = 12 + r() * 26, d = 12 + r() * 4;
    const t = windowTex(parede, vidro, false, 4, 4); t.repeat.set(Math.round(w / 3.6) / 4, Math.round(h / 3.2) / 4);
    const aceso = windowTex(parede, vidro, true, 4, 4); aceso.repeat.copy(t.repeat);
    const lado = new THREE.MeshLambertMaterial({ map: t, emissiveMap: aceso, emissive: new THREE.Color(0, 0, 0) }), topo = lam(new THREE.Color(parede).multiplyScalar(.6));
    R.cityWindows.push(lado); // acendem à noite com as da cidade
    bloco(g, w, h, d, [lado, lado, topo, topo, lado, lado], x, 0, fundo - d / 2 - r() * 6);
  }
}
/* Desempenho: cada cartão-postal tem centenas de peças (janelas, pináculos, bancos...), e cada
 * peça era uma chamada de desenho na cena, nas sombras e nos retrovisores (até ~2.100 por quadro em
 * Matipó). Depois de montado, as peças estáticas com o mesmo material viram uma malha só (a
 * geometria já transformada para o referencial do grupo). Os halos dos postes (sprites) ficam; os
 * materiais são os mesmos, então a iluminação noturna (NOITE, R.cityWindows) continua valendo. */
function fundirMalhas(g) {
  g.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), rel = new THREE.Matrix4();
  const porMat = new Map(), pecas = [];
  g.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh) return;
    pecas.push(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geo.applyMatrix4(rel.multiplyMatrices(inv, o.matrixWorld));
    const n = geo.attributes.position.count;
    const grupos = Array.isArray(o.material) && geo.groups.length ? geo.groups : [{ start: 0, count: n, materialIndex: 0 }];
    for (const gr of grupos) {
      const mat = mats[gr.materialIndex]; if (!mat) continue;
      let a = porMat.get(mat);
      if (!a) porMat.set(mat, a = { pos: [], nor: [], uv: [], cor: [], temCor: false, sombra: false });
      a.sombra ||= o.castShadow;
      const P = geo.attributes.position.array, N = geo.attributes.normal?.array, U = geo.attributes.uv?.array, K = geo.attributes.color?.array;
      a.temCor ||= !!K; // cor por vértice (as árvores)
      for (let i = gr.start; i < Math.min(n, gr.start + gr.count); i++) {
        a.pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        if (N) a.nor.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]); else a.nor.push(0, 1, 0);
        if (U) a.uv.push(U[i * 2], U[i * 2 + 1]); else a.uv.push(0, 0);
        if (K) a.cor.push(K[i * 3], K[i * 3 + 1], K[i * 3 + 2]); else a.cor.push(1, 1, 1);
      }
    }
    geo.dispose();
  });
  for (const o of pecas) o.parent.remove(o);
  for (const [mat, a] of porMat) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(a.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2));
    if (a.temCor) geo.setAttribute('color', new THREE.Float32BufferAttribute(a.cor, 3));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat); m.castShadow = a.sombra; m.receiveShadow = true; g.add(m);
  }
}
function buildPostais() {
  const G = buildTreeGeos();
  R.postalArvoreMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  R.postais = { igreja: igrejaMatipo(G), praca: pracaDoCafe(G), univertix: univertix(G) };
  loteUrbano(R.postais.igreja, -62, 3); loteUrbano(R.postais.praca, -56, 7); loteUrbano(R.postais.univertix, -64, 11);
  for (const g of Object.values(R.postais)) fundirMalhas(g);
  for (const g of Object.values(R.postais)) { g.visible = false; scene.add(g); }
}
function updatePostais() {
  // iluminação noturna: cresce com a noite (a partir do entardecer), igual às janelas da cidade
  const k = clamp(env.night * 1.3 - .15, 0, 1);
  if (k !== NOITE.k) {
    NOITE.k = k;
    for (const { mat, cor, forca } of NOITE.mats) mat.emissive.copy(cor).multiplyScalar(forca * k);
    for (const h of NOITE.halos) h.material.opacity = .85 * k;
  }
  const vistos = new Set();
  for (const p of world.postais) {
    const g = R.postais[p.tipo], z = -(p.S - world.distance);
    if (!g || z < -900 || z > 320 || vistos.has(p.tipo)) continue;
    vistos.add(p.tipo);
    g.visible = true;
    g.position.set(p.lado > 0 ? CALCADA_FIM : -(CALCADA_FIM + ESQ), 0, z);
    g.rotation.y = p.lado > 0 ? -Math.PI / 2 : Math.PI / 2; // a fachada (+z do grupo) olha para a via
  }
  for (const [tipo, g] of Object.entries(R.postais)) if (!vistos.has(tipo)) g.visible = false;
  // a rede elétrica corre à esquerda: some enquanto um lote reservado desse lado estiver à vista
  const esquerda = world.postais.some(p => p.lado < 0 && p.S - world.distance > -400 && p.S - world.distance < 1000);
  for (const f of R.fios || []) f.visible = !esquerda;
}

/* ---------- pessoas: pedestres e guardas de trânsito ---------- */
const personGeo = {}, matMemo = new Map();
function matOf(color) { if (!matMemo.has(color)) matMemo.set(color, lam(color)); return matMemo.get(color); }
function buildPerson(shirt, pants, skin, officer) {
  if (!personGeo.leg) {
    personGeo.leg = new THREE.BoxGeometry(.15, .85, .15); personGeo.leg.translate(0, -.425, 0);
    personGeo.arm = new THREE.BoxGeometry(.11, .62, .11); personGeo.arm.translate(0, -.31, 0);
    personGeo.torso = new THREE.BoxGeometry(.42, .62, .24);
    personGeo.head = new THREE.SphereGeometry(.13, 10, 8);
    personGeo.hair = new THREE.SphereGeometry(.135, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    personGeo.cap = new THREE.CylinderGeometry(.15, .15, .08, 10);
  }
  const G = personGeo, g = new THREE.Group();
  const mShirt = matOf(officer ? '#d9ff3a' : shirt), mPants = matOf(officer ? '#1f2a44' : pants);
  const limb = (geo, mat, y, x) => { const p = new THREE.Group(); p.position.set(x, y, 0); const m = new THREE.Mesh(geo, mat); m.castShadow = true; p.add(m); g.add(p); return p; };
  const legL = limb(G.leg, mPants, .88, -.1), legR = limb(G.leg, mPants, .88, .1);
  const torso = new THREE.Mesh(G.torso, mShirt); torso.position.y = 1.2; torso.castShadow = true; g.add(torso);
  const armL = limb(G.arm, mShirt, 1.48, -.27), armR = limb(G.arm, mShirt, 1.48, .27);
  const head = new THREE.Mesh(G.head, matOf(skin)); head.position.y = 1.66; g.add(head);
  const hair = new THREE.Mesh(G.hair, matOf(officer ? '#f4f4f2' : pick3(['#1a1410', '#3b2a1e', '#6b4a2a', '#c9a46a']))); hair.position.y = 1.68; g.add(hair);
  if (officer) { const cap = new THREE.Mesh(G.cap, matOf('#f4f4f2')); cap.position.y = 1.78; g.add(cap); }
  g.add(blobShadow(.5, .5));
  g.userData = { legL, legR, armL, armR };
  return g;
}
function pick3(a) { return a[Math.floor(Math.random() * a.length)]; }
function buildPeople() {
  R.peds = new Map(); R.officers = [];
  for (let i = 0; i < 4; i++) { const g = buildPerson(null, null, '#c99a72', true); g.visible = false; scene.add(g); R.officers.push(g); }
  for (const p of world.peds) { const g = buildPerson(p.shirt, p.pants, p.skin, false); g.visible = false; scene.add(g); R.peds.set(p.id, g); }
}
function updatePeople(t) {
  const d = world.distance;
  for (const p of world.peds) {
    let g = R.peds.get(p.id);
    if (!p.active) { if (g) g.visible = false; continue; }
    if (!g) { g = buildPerson(p.shirt, p.pants, p.skin, false); scene.add(g); R.peds.set(p.id, g); }
    g.visible = true;
    g.position.set(p.x, 0, -(p.S - d));
    g.rotation.y = p.dir > 0 ? 0 : Math.PI;
    const sw = Math.sin(p.phase) * .5, u = g.userData;
    u.legL.rotation.x = sw; u.legR.rotation.x = -sw; u.armL.rotation.x = -sw * .8; u.armR.rotation.x = sw * .8;
  }
  // guarda de trânsito na esquina de cada cruzamento urbano, de frente para a pista
  const list = V.crossingsBetween(d - 120, d + 450);
  R.officers.forEach((g, i) => {
    const S = list[i];
    g.visible = S != null;
    if (S == null) return;
    g.position.set(7.9, .16, -(S + 5 - d));
    g.rotation.y = Math.PI / 2;
    const u = g.userData, wave = Math.sin(t / 260 + i);
    u.armR.rotation.z = 2.3 + wave * .35;  // braço levantado sinalizando
    u.armR.rotation.x = 0; u.armL.rotation.z = -.15; u.legL.rotation.x = u.legR.rotation.x = 0;
  });
}

/* ---------- animais no cenário (fora da pista) ----------
 * Vacas e cavalos no pasto à esquerda, atrás da cerca; pássaros cruzando o céu.
 * Posição em coordenadas do mundo: S = metros ao longo da rodovia, x = lateral. */
const PASTURE = { min: -48 - V.ROAD.esq, max: FENCE_X - 3 - V.ROAD.esq }; // faixa do pasto visível pelo para-brisa (além da contramão)
function spotsTex() {
  return canvasTex(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#f1efe9'; ctx.fillRect(0, 0, w, h);
    const r = rng(5); ctx.fillStyle = '#1d1c1b';
    for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(r() * w, r() * h, 14 + r() * 26, 10 + r() * 18, r() * 3, 0, 7); ctx.fill(); }
  });
}
function leg(mat, h, r) {
  const pivot = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * .8, h, 6), mat); m.position.y = -h / 2; m.castShadow = true;
  pivot.add(m); return pivot;
}
// Modelo voltado para -Z. kind: 'cow' | 'horse'
function buildAnimal(kind) {
  const g = new THREE.Group(), cow = kind === 'cow';
  const coat = cow ? new THREE.MeshLambertMaterial({ map: R.spots || (R.spots = spotsTex()) }) : lam(['#6b4329', '#3b2a1e', '#8a5a36'][Math.floor(Math.random() * 3)]);
  const dark = lam(cow ? '#2a2724' : '#22180f');
  const L = cow ? 1.9 : 2.1, legH = cow ? .75 : 1.05, bodyY = legH + (cow ? .42 : .38);
  const body = new THREE.Mesh(new THREE.BoxGeometry(cow ? .85 : .7, cow ? .85 : .75, L), coat);
  body.position.y = bodyY; body.castShadow = true; g.add(body);
  // pescoço + cabeça num pivô (abaixa para pastar)
  const neck = new THREE.Group(); neck.position.set(0, bodyY + .2, -L / 2 + .05); g.add(neck);
  const nk = new THREE.Mesh(new THREE.BoxGeometry(cow ? .4 : .32, cow ? .45 : .7, cow ? .45 : .4), coat);
  nk.position.set(0, cow ? 0 : .25, -.2); nk.rotation.x = cow ? 0 : -.6; neck.add(nk);
  const head = new THREE.Mesh(new THREE.BoxGeometry(cow ? .38 : .28, cow ? .4 : .32, cow ? .55 : .62), cow ? coat : coat);
  head.position.set(0, cow ? .02 : .55, cow ? -.55 : -.62); head.castShadow = true; neck.add(head);
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(cow ? .34 : .24, .2, .16), dark); muzzle.position.set(0, cow ? -.08 : .48, cow ? -.84 : -.95); neck.add(muzzle);
  if (cow) for (const s of [-1, 1]) { const horn = new THREE.Mesh(new THREE.ConeGeometry(.04, .18, 5), lam('#ddd3bd')); horn.position.set(s * .17, .26, -.45); horn.rotation.z = -s * .6; neck.add(horn); }
  else { const mane = new THREE.Mesh(new THREE.BoxGeometry(.08, .55, .3), dark); mane.position.set(0, .45, -.05); mane.rotation.x = -.6; neck.add(mane); }
  const legs = [];
  for (const [x, z] of [[-.28, -L / 2 + .25], [.28, -L / 2 + .25], [-.28, L / 2 - .25], [.28, L / 2 - .25]]) {
    const p = leg(dark, legH, cow ? .08 : .065); p.position.set(x * (cow ? 1 : .85), legH, z); g.add(p); legs.push(p);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(.06, cow ? .7 : .8, .06), dark); tail.position.set(0, bodyY - .2, L / 2 + .04); tail.rotation.x = .25; g.add(tail);
  g.add(blobShadow(cow ? .9 : .8, L));
  g.userData = { legs, neck, tail, kind };
  return g;
}
function buildBird() {
  const g = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color: 0x1e2228, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.BoxGeometry(.08, .07, .3), mat); g.add(body);
  const wings = [];
  for (const s of [-1, 1]) {
    const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(s * .45, .08); shape.lineTo(s * .38, -.1); shape.lineTo(0, -.12);
    const w = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat); w.rotation.x = -Math.PI / 2; const pv = new THREE.Group(); pv.add(w); g.add(pv); wings.push(pv);
  }
  g.userData = { wings, phase: Math.random() * 6 };
  return g;
}
function placeAnimal(a, ahead) {
  a.S = world.distance + (ahead ? 140 + Math.random() * 300 : -60 + Math.random() * 420);
  a.x = PASTURE.min + Math.random() * (PASTURE.max - PASTURE.min);
  a.heading = Math.random() * Math.PI * 2; a.state = Math.random() < .6 ? 'graze' : 'walk'; a.timer = 2 + Math.random() * 6;
}
function buildAnimals() {
  R.animals = [];
  for (let i = 0; i < 14; i++) {
    const kind = i < 10 ? 'cow' : 'horse';
    const a = { kind, g: buildAnimal(kind), phase: Math.random() * 6, speed: kind === 'cow' ? .7 : 1.3 };
    placeAnimal(a, false); scene.add(a.g); R.animals.push(a);
  }
  // bando de pássaros
  R.flock = { birds: [], S: 0, x: 0, y: 0, vx: 0, vS: 0 };
  for (let i = 0; i < 9; i++) { const b = buildBird(); b.userData.off = new THREE.Vector3((Math.random() - .5) * 10, (Math.random() - .5) * 3, (Math.random() - .5) * 8); scene.add(b); R.flock.birds.push(b); }
  resetFlock();
}
function resetFlock() {
  const f = R.flock, dir = Math.random() < .5 ? -1 : 1;
  f.x = -dir * (90 + Math.random() * 40); f.vx = dir * (7 + Math.random() * 4);
  f.S = world.distance + 120 + Math.random() * 220; f.vS = (Math.random() - .5) * 4; f.y = 22 + Math.random() * 18;
}
function updateAnimals(dt, t) {
  const night = env.night;
  for (const a of R.animals) {
    const u = a.g.userData;
    a.timer -= dt;
    if (a.timer < 0) { // alterna entre pastar e caminhar
      a.state = a.state === 'graze' ? 'walk' : 'graze';
      a.timer = a.state === 'walk' ? 2.5 + Math.random() * 4 : 4 + Math.random() * 8;
      if (a.state === 'walk') a.heading += (Math.random() - .5) * 1.6;
    }
    // não sai do pasto: vira de volta para o centro (a cerca fica entre o pasto e a rodovia)
    const dx = -Math.sin(a.heading);
    if ((a.x > PASTURE.max - 1 && dx > 0) || (a.x < PASTURE.min + 1 && dx < 0)) a.heading = -a.heading;
    const walking = a.state === 'walk';
    if (walking) {
      a.x += -Math.sin(a.heading) * a.speed * dt; a.S += Math.cos(a.heading) * a.speed * dt;
      a.x = clamp(a.x, PASTURE.min, PASTURE.max);
      a.phase += dt * a.speed * 5;
    }
    const swing = walking ? Math.sin(a.phase) * .45 : 0;
    u.legs[0].rotation.x = swing; u.legs[3].rotation.x = swing; u.legs[1].rotation.x = -swing; u.legs[2].rotation.x = -swing;
    u.neck.rotation.x += ((walking ? .05 : .85 + Math.sin(t / 700 + a.phase) * .08) - u.neck.rotation.x) * clamp(dt * 2, 0, 1);
    u.tail.rotation.z = Math.sin(t / 380 + a.phase) * .25;
    if (a.S - world.distance < -200) placeAnimal(a, true);
    a.g.position.set(a.x, 0, -(a.S - world.distance));
    a.g.rotation.y = a.heading;
    a.g.visible = night < .85 && V.cityAmount(a.S) < .3; // recolhidos à noite e ausentes na cidade
  }
  const f = R.flock;
  f.x += f.vx * dt; f.S += f.vS * dt;
  if (Math.abs(f.x) > 160 || f.S - world.distance < -150) resetFlock();
  for (const b of f.birds) {
    const u = b.userData, o = u.off;
    b.position.set(f.x + o.x, f.y + o.y + Math.sin(t / 500 + u.phase) * .4, -(f.S - world.distance) + o.z);
    b.rotation.y = f.vx > 0 ? -Math.PI / 2 : Math.PI / 2;
    const flap = Math.sin(t / 90 + u.phase) * .7;
    u.wings[0].rotation.z = flap; u.wings[1].rotation.z = -flap;
    b.visible = night < .6;
  }
}

/* ---------- veículos ---------- */
const shared = {};
function blobShadow(w, l) {
  if (!shared.blob) shared.blob = canvasTex(64, 128, (ctx, cw, ch) => { const g = ctx.createRadialGradient(cw / 2, ch / 2, 4, cw / 2, ch / 2, ch / 2); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch); });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.3, l * 1.15), new THREE.MeshBasicMaterial({ map: shared.blob, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = .02; return m;
}
function wheel(r, w) {
  if (!shared.wheelGeo) { shared.wheelGeo = new THREE.CylinderGeometry(1, 1, 1, 14); shared.wheelGeo.rotateZ(Math.PI / 2); shared.tire = lam('#1b1c1e'); shared.hub = std('#9ea3a8', { metalness: .6, roughness: .35 }); }
  const g = new THREE.Group();
  const t = new THREE.Mesh(shared.wheelGeo, shared.tire); t.scale.set(w, r, r); g.add(t);
  const h = new THREE.Mesh(shared.wheelGeo, shared.hub); h.scale.set(w * 1.02, r * .55, r * .55); g.add(h);
  return g;
}
function lightBox(w, h, d, color, intensity = 1) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
  m.userData.base = C(color); m.userData.intensity = intensity; return m;
}
function glowSprite(color, size) {
  if (!shared.glow) shared.glow = radialTex([[0, 'rgba(255,255,255,1)'], [.2, 'rgba(255,255,255,.55)'], [1, 'rgba(255,255,255,0)']]);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  s.scale.set(size, size, 1); s.userData.size = size; return s;
}

// Modelos voltados para -Z (frente). Origem no centro, no chão.
// Caminhões com baú: carreta, toco e 3/4 variam só nas proporções.
const TRUCK_SPECS = {
  truck:   { L: 16.5, W: 2.55, cabL: 2.3, cabH: 2.5, cabW: 2.5, boxH: 2.85, roof: true,  wheelR: .52, axles: [1.3, 4.2, 5.5, -3.2, -2.0, -.8] },
  toco:    { L: 9.2,  W: 2.45, cabL: 2.1, cabH: 2.3, cabW: 2.4, boxH: 2.6,  roof: false, wheelR: .5,  axles: [1.15, -1.7] },
  truck34: { L: 6.9,  W: 2.15, cabL: 1.9, cabH: 2.0, cabW: 2.05, boxH: 2.3, roof: false, wheelR: .42, axles: [1.0, -1.3] }
};
function buildTruck(cabColor, boxColor, spec = TRUCK_SPECS.truck) {
  const { L, W, cabL, cabH, cabW, boxH, roof, wheelR, axles } = spec, half = L / 2;
  const g = new THREE.Group();
  g.add(blobShadow(W, L));
  const glass = std('#1b2733', { metalness: .3, roughness: .15 });
  const cabMat = std(cabColor, { metalness: .2, roughness: .45 });
  const dark = lam('#202326');
  const chassisY = wheelR + .2, cabY = chassisY + cabH / 2;
  // cabine
  const cab = new THREE.Mesh(new THREE.BoxGeometry(cabW, cabH, cabL), cabMat);
  cab.position.set(0, cabY, -half + cabL / 2); cab.castShadow = true; g.add(cab);
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(cabW * .9, cabH * .38), glass); ws.position.set(0, cabY + cabH * .2, -half - .01); ws.rotation.y = Math.PI; g.add(ws);
  for (const s of [-1, 1]) { const sw = new THREE.Mesh(new THREE.PlaneGeometry(cabL * .45, cabH * .32), glass); sw.position.set(s * (cabW / 2 + .005), cabY + cabH * .2, -half + cabL * .3); sw.rotation.y = s * Math.PI / 2; g.add(sw); }
  const visor = new THREE.Mesh(new THREE.BoxGeometry(cabW, .1, .3), cabMat); visor.position.set(0, cabY + cabH * .45, -half + .02); g.add(visor);
  if (roof) { const rf = new THREE.Mesh(new THREE.BoxGeometry(cabW * .96, .75, cabL * .7), cabMat); rf.position.set(0, cabY + cabH / 2 + .37, -half + cabL * .6); rf.castShadow = true; g.add(rf); }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(cabW * .6, cabH * .3, .06), dark); grille.position.set(0, cabY - cabH * .2, -half - .02); g.add(grille);
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(cabW, .32, .26), lam('#55595e')); bumper.position.set(0, chassisY - .02, -half + .1); g.add(bumper);
  const fronts = [], tails = [];
  for (const s of [-1, 1]) {
    const hl = lightBox(.36, .18, .05, '#fffbe6'); hl.position.set(s * cabW * .36, chassisY + .3, -half - .02); g.add(hl); fronts.push(hl);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(.06, .5, .2), dark); arm.position.set(s * (cabW / 2 + .15), cabY + cabH * .15, -half + .35); g.add(arm);
  }
  // chassi e baú
  const boxL = L - cabL - .2;
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1, .3, L - .6), dark); chassis.position.set(0, chassisY, .2); g.add(chassis);
  const side = new THREE.MeshLambertMaterial({ map: ribTex(boxColor) });
  const plain = lam(boxColor);
  const rear = new THREE.MeshLambertMaterial({ map: doorTex(boxColor) });
  const box = new THREE.Mesh(new THREE.BoxGeometry(W, boxH, boxL), [side, side, plain, dark, rear, plain]);
  box.position.set(0, chassisY + .2 + boxH / 2, half - boxL / 2); box.castShadow = true; box.receiveShadow = true; g.add(box);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(W * .88, .14, .12), dark); guard.position.set(0, chassisY - .15, half - .1); g.add(guard);
  for (const s of [-1, 1]) {
    const tl = lightBox(.3, .16, .05, '#ff1d1d'); tl.position.set(s * W * .4, chassisY + .05, half + .02); g.add(tl); tails.push(tl);
  }
  const wheels = [];
  for (const a of axles) {
    const z = a > 0 ? -half + a : half + a; // positivo = medido da frente; negativo = da traseira
    for (const s of [-1, 1]) { const w = wheel(wheelR, .32); w.position.set(s * (W / 2 - .2), wheelR, z); g.add(w); wheels.push(w); }
  }
  addLightGlows(g, fronts, tails, half, W > 2.4 ? 1 : .85);
  Object.assign(g.userData, { fronts, tails, wheels, len: L, wheelR });
  return g;
}

// Habitáculo de carro: caixa com vértices superiores recolhidos (para-brisa e traseira inclinados).
function cabinGeo(w, h, l, frontRake, rearRake, narrow = .86) {
  const g = new THREE.BoxGeometry(w, h, l), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) {
    p.setX(i, p.getX(i) * narrow);
    p.setZ(i, p.getZ(i) < 0 ? p.getZ(i) + frontRake : p.getZ(i) - rearRake);
  }
  g.computeVertexNormals(); return g;
}
function carBase(g, W, L, bodyH, bodyY, color, wheelR, lightY) {
  const half = L / 2, body = std(color, { metalness: .15, roughness: .38 }); // sem envMap, metal alto escurece a pintura
  const lower = new THREE.Mesh(new THREE.BoxGeometry(W, bodyH, L), body); lower.position.y = bodyY; lower.castShadow = true; g.add(lower);
  const fronts = [], tails = [];
  for (const s of [-1, 1]) {
    const hl = lightBox(W * .2, .12, .05, '#fffbe6'); hl.position.set(s * (W / 2 - W * .17), lightY, -half - .01); g.add(hl); fronts.push(hl);
    const tl = lightBox(W * .2, .13, .05, '#ff1d1d'); tl.position.set(s * (W / 2 - W * .15), lightY + .04, half + .01); g.add(tl); tails.push(tl);
  }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(.48, .14, .03), lam('#e8e8e8')); plate.position.set(0, bodyY - bodyH * .2, half + .02); g.add(plate);
  const wheels = [];
  for (const z of [-half + L * .19, half - L * .2]) for (const s of [-1, 1]) { const w = wheel(wheelR, .22); w.position.set(s * (W / 2 - .1), wheelR, z); g.add(w); wheels.push(w); }
  return { body, fronts, tails, wheels };
}
const GLASS = () => std('#1b2733', { metalness: .3, roughness: .15 });
// Sedã
function buildCar(color) {
  const g = new THREE.Group(), L = 4.5, W = 1.8; g.add(blobShadow(W, L));
  const { body, fronts, tails, wheels } = carBase(g, W, L, .62, .66, color, .33, .78), glass = GLASS();
  const cabin = new THREE.Mesh(cabinGeo(W * .92, .6, L * .5, .32, .3), [glass, glass, body, body, glass, glass]);
  cabin.position.set(0, 1.27, .2); cabin.castShadow = true; g.add(cabin);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * .5, .14, .04), lam('#1d1f22')); grille.position.set(0, .62, -L / 2 - .01); g.add(grille);
  addLightGlows(g, fronts, tails, L / 2, .7);
  Object.assign(g.userData, { fronts, tails, wheels, len: L, wheelR: .33 });
  return g;
}
// VW Gol "bolinha": hatch curto e alto, traseira quase vertical, para-choques pretos
function buildGol(color) {
  const g = new THREE.Group(), L = 3.9, W = 1.64; g.add(blobShadow(W, L));
  const { body, fronts, tails, wheels } = carBase(g, W, L, .6, .62, color, .31, .74), glass = GLASS();
  const cabin = new THREE.Mesh(cabinGeo(W * .93, .64, L * .56, .42, .08, .84), [glass, glass, body, body, glass, glass]);
  cabin.position.set(0, 1.24, .38); cabin.castShadow = true; g.add(cabin);
  const black = lam('#1a1b1d');
  for (const z of [-L / 2 - .03, L / 2 + .03]) { const b = new THREE.Mesh(new THREE.BoxGeometry(W + .04, .2, .14), black); b.position.set(0, .45, z); g.add(b); }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * .62, .16, .04), black); grille.position.set(0, .74, -L / 2 - .01); g.add(grille);
  addLightGlows(g, fronts, tails, L / 2, .65);
  Object.assign(g.userData, { fronts, tails, wheels, len: L, wheelR: .31 });
  return g;
}
// Caminhonete cabine dupla com caçamba aberta
function buildPickup(color) {
  const g = new THREE.Group(), L = 5.3, W = 1.9, half = L / 2; g.add(blobShadow(W, L));
  const { body, fronts, tails, wheels } = carBase(g, W, L, .72, .9, color, .38, 1.0), glass = GLASS();
  const cabin = new THREE.Mesh(cabinGeo(W * .94, .72, 2.5, .38, .04, .9), [glass, glass, body, body, glass, glass]);
  cabin.position.set(0, 1.62, -half + 1.0 + 1.25); cabin.castShadow = true; g.add(cabin);
  // caçamba: paredes laterais e tampa traseira
  const bedL = L - 3.65, bedZ = half - bedL / 2;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W * .9, .05, bedL), lam('#2a2c2f')); floor.position.set(0, 1.27, bedZ); g.add(floor);
  for (const s of [-1, 1]) { const wall = new THREE.Mesh(new THREE.BoxGeometry(.06, .45, bedL), body); wall.position.set(s * (W / 2 - .03), 1.48, bedZ); wall.castShadow = true; g.add(wall); }
  const gate = new THREE.Mesh(new THREE.BoxGeometry(W, .45, .06), body); gate.position.set(0, 1.48, half - .03); g.add(gate);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(W * .9, .06, .06), std('#c9ccd0', { metalness: .5, roughness: .3 })); bar.position.set(0, 1.9, half - bedL + .1); g.add(bar);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * .6, .28, .04), lam('#18191b')); grille.position.set(0, .95, -half - .01); g.add(grille);
  addLightGlows(g, fronts, tails, half, .75);
  Object.assign(g.userData, { fronts, tails, wheels, len: L, wheelR: .38 });
  return g;
}
// Van furgão (tipo Sprinter/Master): capô curto e baú alto
function buildVan(color) {
  const g = new THREE.Group(), L = 5.9, W = 2.0, half = L / 2; g.add(blobShadow(W, L));
  const body = std(color, { metalness: .15, roughness: .4 }), glass = GLASS(), dark = lam('#1d1f22');
  const hood = new THREE.Mesh(new THREE.BoxGeometry(W * .96, .8, 1.0), body); hood.position.set(0, .9, -half + .5); hood.castShadow = true; g.add(hood);
  const rearDoor = new THREE.MeshLambertMaterial({ map: doorTex(color) });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(W, 2.15, L - .95), [body, body, body, dark, rearDoor, body]);
  shell.position.set(0, 1.55, .47); shell.castShadow = true; g.add(shell);
  // para-brisa inclinado para trás, à frente da face do baú
  const ws = new THREE.Mesh(new THREE.BoxGeometry(W * .9, .8, .06), glass); ws.position.set(0, 1.9, .47 - (L - .95) / 2 - .03); ws.rotation.x = .3; g.add(ws);
  for (const s of [-1, 1]) { const sw = new THREE.Mesh(new THREE.PlaneGeometry(.8, .6), glass); sw.position.set(s * (W / 2 + .005), 1.95, -half + 1.4); sw.rotation.y = s * Math.PI / 2; g.add(sw); }
  const fronts = [], tails = [];
  for (const s of [-1, 1]) {
    const hl = lightBox(.36, .16, .05, '#fffbe6'); hl.position.set(s * (W / 2 - .3), 1.05, -half - .01); g.add(hl); fronts.push(hl);
    const tl = lightBox(.14, .5, .05, '#ff1d1d'); tl.position.set(s * (W / 2 - .1), 1.15, half + .01); g.add(tl); tails.push(tl);
  }
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(W, .22, .14), dark); bumper.position.set(0, .5, -half - .03); g.add(bumper);
  const wheels = [];
  for (const z of [-half + .9, half - 1.0]) for (const s of [-1, 1]) { const w = wheel(.36, .24); w.position.set(s * (W / 2 - .12), .36, z); g.add(w); wheels.push(w); }
  addLightGlows(g, fronts, tails, half, .8);
  Object.assign(g.userData, { fronts, tails, wheels, len: L, wheelR: .36 });
  return g;
}
const BUILDERS = {
  truck: v => buildTruck(v.cab || '#f4f4f2', v.color, TRUCK_SPECS.truck),
  toco: v => buildTruck(v.cab || '#f4f4f2', v.color, TRUCK_SPECS.toco),
  truck34: v => buildTruck(v.cab || '#f4f4f2', v.color, TRUCK_SPECS.truck34),
  van: v => buildVan(v.color), pickup: v => buildPickup(v.color), gol: v => buildGol(v.color), car: v => buildCar(v.color)
};
function addLightGlows(g, fronts, tails, half, scale) {
  const fg = [], tg = [];
  for (const f of fronts) { const s = glowSprite(0xfff4d0, 2.4 * scale); s.position.copy(f.position).add(new THREE.Vector3(0, 0, -.15)); g.add(s); fg.push(s); }
  for (const t of tails) { const s = glowSprite(0xff2a1a, 1.5 * scale); s.position.copy(t.position).add(new THREE.Vector3(0, 0, .15)); g.add(s); tg.push(s); }
  // poça de luz dos faróis no asfalto
  if (!shared.beam) shared.beam = beamTex();
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(5, 26), new THREE.MeshBasicMaterial({ map: shared.beam, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
  beam.rotation.x = -Math.PI / 2; beam.position.set(0, .03, -half - 13); g.add(beam);
  g.userData.frontGlows = fg; g.userData.tailGlows = tg; g.userData.beam = beam;
}
// seta: -1 esquerda, 1 direita; pisca junto com o pisca-alerta (world.pisca), no lado da lanterna
// alto: farol alto aceso agora (o veículo da contramão piscando para o ego), um clarão forte
function setVehicleLights(g, night, braking, hazard, seta = 0, alto = false) {
  const u = g.userData;
  // faróis: halo contido para não ofuscar a visão
  u.frontGlows.forEach(s => { s.material.opacity = alto ? 1 : .18 + night * .37; const k = alto ? 3.2 : .8 + night * .7; s.scale.set(s.userData.size * k, s.userData.size * k, 1); });
  u.tailGlows.forEach(s => {
    const lado = Math.sign(s.position.x), pisca = world.pisca && (hazard || (seta && seta === lado));
    s.material.opacity = Math.min(1, (braking ? .9 : night * .7) + (pisca ? .7 : 0));
  });
  u.tails.forEach(t => t.material.color.copy(t.userData.base).multiplyScalar(braking || night > .3 ? 1 : .55));
  u.beam.material.opacity = alto ? .55 : night * .3;
}

const pools = {}; // modelos reaproveitados por tipo
const active = new Map();
// Reaproveitamento de modelos: construir um veículo novo (geometria, materiais, envio à GPU)
// no meio da viagem causava uma travada a cada carro que surgia. Agora um modelo guardado do
// mesmo tipo é repintado com as cores do novo veículo; só se constrói quando não há nenhum.
const isTruck = kind => kind === 'truck' || kind === 'toco' || kind === 'truck34';
function marcarPintura(g, v) {
  const cor = new THREE.Color(v.color).getHex(), cab = v.cab ? new THREE.Color(v.cab).getHex() : null;
  const rib = isTruck(v.kind) ? ribTex(v.color) : null, door = isTruck(v.kind) ? doorTex(v.color) : null;
  const pintura = [];
  g.traverse(o => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m || pintura.some(p => p.m === m)) continue;
      if (rib && m.map === rib) pintura.push({ m, papel: 'rib' });
      else if (door && m.map === door) pintura.push({ m, papel: 'door' });
      else if (!m.map && m.color && !m.emissiveMap && m.color.getHex() === cor) pintura.push({ m, papel: 'cor' });
      else if (!m.map && m.color && cab !== null && m.color.getHex() === cab) pintura.push({ m, papel: 'cab' });
    }
  });
  g.userData.pintura = pintura;
}
function repintar(g, v) {
  for (const { m, papel } of g.userData.pintura || []) {
    if (papel === 'cor') m.color.set(v.color);
    else if (papel === 'cab') m.color.set(v.cab || '#f4f4f2');
    else if (papel === 'rib') m.map = ribTex(v.color);
    else if (papel === 'door') m.map = doorTex(v.color);
  }
  Object.assign(g.userData, { color: v.color, cab: v.cab });
}
function acquire(key, v) {
  let g = active.get(key);
  if (g && g.userData.kind === v.kind && g.userData.color === v.color && g.userData.cab === v.cab) return g;
  if (g) release(key);
  const pool = pools[v.kind] || (pools[v.kind] = []);
  g = pool.find(p => p.userData.color === v.color && p.userData.cab === v.cab) || pool[pool.length - 1];
  if (g) { pool.splice(pool.indexOf(g), 1); if (g.userData.color !== v.color || g.userData.cab !== v.cab) repintar(g, v); }
  else {
    g = (BUILDERS[v.kind] || BUILDERS.car)(v);
    Object.assign(g.userData, { kind: v.kind, color: v.color, cab: v.cab });
    marcarPintura(g, v);
  }
  g.visible = true; scene.add(g); active.set(key, g);
  return g;
}
function release(key) {
  const g = active.get(key); if (!g) return;
  scene.remove(g); active.delete(key);
  const pool = pools[g.userData.kind] || (pools[g.userData.kind] = []); if (pool.length < 12) pool.push(g);
}

function updateVehicles(dt) {
  const night = env.night, seen = new Set();
  // tráfego nas duas faixas, no mesmo sentido do ego (posição lateral e rumo na troca de faixa)
  for (const t of world.traffic) {
    if (t.z > 700 || t.z < -340) continue;
    const key = 'v' + t.id; seen.add(key);
    const g = acquire(key, t);
    g.position.set(t.x, 0, -t.z);
    g.rotation.y = -(t.heading || 0);
    setVehicleLights(g, night, t.braking, t.crash, t.seta);
    spin(g, (t.kmh / 3.6) * dt);
  }
  // contramão: vêm de frente (modelo virado para +Z), com farol alto piscando quando o ego invade a faixa
  for (const t of world.contramao) {
    if (t.z > 760 || t.z < -340) continue;
    const key = 'c' + t.id; seen.add(key);
    const g = acquire(key, t);
    g.position.set(t.x, 0, -t.z);
    g.rotation.y = Math.PI;
    setVehicleLights(g, night, t.braking, t.crash || t.batido, 0, t.farol && Math.floor(performance.now() / 110) % 2 === 0); // pisca rápido
    spin(g, (t.kmh / 3.6) * dt);
  }
  for (const key of [...active.keys()]) if (!seen.has(key)) release(key);
}
function spin(g, dist) { const u = g.userData; const a = dist / u.wheelR; u.wheels.forEach(w => w.rotation.x -= a); }

/* ---------- placas ---------- */
const signCache = new Map(), signTexCache = new Map();
function getSignTex(kind, value) { const k = kind + String(value); if (!signTexCache.has(k)) signTexCache.set(k, signTex(kind, value)); return signTexCache.get(k); }
function post(h, x = 0) { const m = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, h, 6), std('#9aa0a6', { metalness: .6, roughness: .4 })); m.position.set(x, h / 2, 0); m.castShadow = true; return m; }
function buildSign(s) {
  const g = new THREE.Group(), back = lam('#7d848b');
  const tex = getSignTex(s.type, s.value);
  const face = (geo, y) => { const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: .5 })); m.position.set(0, y, .04); g.add(m); };
  const backOf = (geo, y, rz = 0) => { const m = new THREE.Mesh(geo, back); m.position.set(0, y, .02); m.rotation.set(0, Math.PI, rz); g.add(m); };
  // painel retangular sobre dois postes
  const panel = (w, h, y, x) => {
    g.add(post(y + h / 2, -w * .35)); g.add(post(y + h / 2, w * .35));
    face(new THREE.PlaneGeometry(w, h), y);
    const b = new THREE.Mesh(new THREE.BoxGeometry(w + .05, h + .05, .05), back); b.position.set(0, y, 0); g.add(b);
    g.userData.x = x;
  };
  if (s.type === 'animals') {
    g.add(post(2.6)); face(new THREE.PlaneGeometry(1, 1), 2.45); backOf(new THREE.PlaneGeometry(.7, .7), 2.45, Math.PI / 4);
    g.userData.x = 7.6;
  } else if (s.type === 'noPassing') {
    g.add(post(2.6)); face(new THREE.CircleGeometry(.48, 32), 2.5); backOf(new THREE.CircleGeometry(.48, 32), 2.5);
    g.userData.x = 7.6;
  } else if (s.type === 'pedestrian') {
    g.add(post(2.6)); face(new THREE.PlaneGeometry(1, 1), 2.45); backOf(new THREE.PlaneGeometry(.7, .7), 2.45, Math.PI / 4);
    g.userData.x = 7.1; // na calçada, junto ao meio-fio
  } else if (s.type === 'busStop') {
    g.add(post(2.7)); face(new THREE.PlaneGeometry(.6, .75), 2.4); backOf(new THREE.PlaneGeometry(.6, .75), 2.4);
    // abrigo: cobertura, painel de fundo e banco
    const shelterMat = lam('#5d666f'), glassMat = new THREE.MeshLambertMaterial({ color: 0x9fc4d8, transparent: true, opacity: .35 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.6, .08, 3.4), shelterMat); roof.position.set(1.6, 2.5, 0); g.add(roof);
    const back = new THREE.Mesh(new THREE.BoxGeometry(.05, 1.9, 3.3), glassMat); back.position.set(2.35, 1.4, 0); g.add(back);
    for (const z of [-1.6, 1.6]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(.08, 2.5, .08), shelterMat); leg.position.set(2.3, 1.25, z); g.add(leg); }
    const bench = new THREE.Mesh(new THREE.BoxGeometry(.45, .08, 2.6), lam('#8a6a4a')); bench.position.set(2.0, .5, 0); g.add(bench);
    g.userData.x = 7.2;
  } else if (s.type === 'welcome') panel(4.2, 2.1, 3.0, 9.6);
  else if (s.type === 'city') panel(4.4, 2.6, 3.6, 9.4);
  else if (s.type === 'rest') panel(3.6, 1.8, 2.9, 9.0);
  else if (s.type === 'belt' || s.type === 'distance') panel(2.8, 1.1, 2.4, 8.6);
  else if (s.type === 'vigia') panel(3.4, 1.2, 2.9, 8.6);
  else if (s.type === 'km') {
    g.add(post(1.4)); face(new THREE.PlaneGeometry(.4, .5), 1.35);
    g.userData.x = 7.3;
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.rotation.y = -.12; // levemente voltada para a pista
  return g;
}
const BACK_SIDE = new Set(); // mão única: não há placas para o sentido oposto
function updateSigns() {
  const from = world.distance - 300, to = world.distance + 650; // atrás: continua nos retrovisores
  const list = V.signsBetween(from, to), seen = new Set();
  for (const s of list) {
    const key = s.type + ':' + s.at; seen.add(key);
    let g = signCache.get(key);
    if (!g) { g = buildSign(s); signCache.set(key, g); scene.add(g); }
    g.position.set(g.userData.x, 0, -(s.at - world.distance));
    if (BACK_SIDE.has(s.type)) {
      const bk = 'b' + key; seen.add(bk);
      let b = signCache.get(bk);
      if (!b) { b = buildSign(s); b.rotation.y = Math.PI + .12; signCache.set(bk, b); scene.add(b); }
      b.position.set(-7.6, 0, -(s.at - world.distance) - 30);
    }
  }
  for (const [k, g] of signCache) if (!seen.has(k)) { scene.remove(g); signCache.delete(k); }
}

/* ---------- logotipo pintado no asfalto, na largada ----------
 * assets/vigia_asfalto.png: o logo VIGIA como tinta de marcação (branco, listras do V em amarelo,
 * com desgaste). Atravessa as duas faixas e é alongado no sentido da via, como as inscrições de
 * pista, para ser lido em perspectiva por quem vem. Fica em world.largada (posição na rodovia). */
// Atravessa as quatro faixas (as duas mãos), entre as linhas de bordo, centrado no meio da pista.
const LOGO_PISTA = { largura: 13.8, alonga: 8, x: ROAD_CX };
function buildLogoLargada() {
  const tex = new THREE.TextureLoader().load('assets/vigia_asfalto.png?v=1');
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy?.() || 1;
  const comp = LOGO_PISTA.largura / (1404 / 360) * LOGO_PISTA.alonga;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(LOGO_PISTA.largura, comp), new THREE.MeshStandardMaterial({
    map: tex, transparent: true, roughness: .85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.rotation.x = -Math.PI / 2; m.position.set(LOGO_PISTA.x, .012, 0); m.receiveShadow = true; m.renderOrder = 1;
  R.logoPista = m; scene.add(m);
}
function updateLogoLargada() {
  const m = R.logoPista; if (!m) return;
  const z = (world.largada ?? -1e9) - world.distance;
  m.visible = z > -300 && z < 700;
  m.position.z = -z;
}

/* ---------- veículo próprio (visto apenas pelos retrovisores) ---------- */
function buildEgo() {
  if (R.ego) scene.remove(R.ego);
  const truck = state.vehicle === 'truck';
  const g = new THREE.Group();
  if (truck) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.85, 13.5), [new THREE.MeshLambertMaterial({ map: ribTex('#eef0f2') }), new THREE.MeshLambertMaterial({ map: ribTex('#eef0f2') }), lam('#eef0f2'), lam('#222'), lam('#eef0f2'), lam('#eef0f2')]);
    box.position.set(0, 2.68, 8.4); box.castShadow = true; g.add(box);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 2.3), std('#1f5fa8', { metalness: .3, roughness: .4 })); cab.position.set(0, 1.95, .2); g.add(cab);
    for (const z of [3.5, 13.2, 14.4]) for (const s of [-1, 1]) { const w = wheel(.52, .34); w.position.set(s * 1.08, .52, z); g.add(w); }
  } else {
    const body = std('#2a6f8f', { metalness: .15, roughness: .38 });
    // só aparece nos retrovisores: vai até o para-choque traseiro da caixa física (2,4 m atrás do
    // motorista, egoFisico em core.js); a frente fica abaixo do painel, fora da vista
    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.8, .62, 3.35), body); lower.position.set(0, .66, .725); g.add(lower);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, .6, 1.8), [std('#121a22', { metalness: .8, roughness: .1 }), std('#121a22', { metalness: .8, roughness: .1 }), body, body, body, body]); top.position.set(0, 1.27, 1.0); g.add(top);
  }
  // lanternas traseiras (a cor muda com o freio, em update)
  R.egoTails = [];
  const [tz, ty, tx] = truck ? [15.16, 1.25, 1.12] : [2.41, .82, .68];
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(truck ? .32 : .36, truck ? .22 : .14), new THREE.MeshBasicMaterial({ color: 0x400505 }));
    m.position.set(s * tx, ty, tz); g.add(m); R.egoTails.push(m);
    const brilho = glowSprite(0xff2418, truck ? 1.6 : 1.3); // halo: forte ao frear
    brilho.position.set(s * tx, ty, tz + .05); g.add(brilho); m.userData.brilho = brilho;
  }
  g.position.x = egoX();
  // tiro no escapamento: chama atrás do veículo (vista pelos retrovisores)
  R.egoChama = glowSprite(0xff8a20, truck ? 2.2 : 1.6);
  R.egoChama.position.set(truck ? .9 : .5, truck ? .7 : .32, (truck ? 15.2 : 2.4) + .5); g.add(R.egoChama);
  R.ego = g; scene.add(g);
}

/* ---------- iluminação e ambiente ---------- */
let PAL;
function makePalette() { return {
  dayTop: C('#2f6fc4'), dayHorizon: C('#b8d4ea'), dayFog: C('#b4c9d6'),
  duskTop: C('#3b4a86'), duskHorizon: C('#f29a5c'), duskFog: C('#c79478'),
  nightTop: C('#02060f'), nightHorizon: C('#0f1a30'), nightFog: C('#0b1322'),
  hemiSkyDay: C('#cfe4ff'), hemiGroundDay: C('#5a6b3c'), hemiSkyNight: C('#2a3a66'), hemiGroundNight: C('#0b0f12'),
  sunDay: C('#fff5e2'), sunLow: C('#ffb070')
}; }
function updateLighting() {
  PAL = PAL || makePalette();
  const n = env.night, el = env.sunElevation;
  const dusk = clamp(1 - Math.abs(el) / .32, 0, 1) * (1 - n * .6);
  let top = lerpColor(PAL.dayTop, PAL.nightTop, n), hor = lerpColor(PAL.dayHorizon, PAL.nightHorizon, n), fog = lerpColor(PAL.dayFog, PAL.nightFog, n);
  top.lerp(PAL.duskTop, dusk * .5); hor.lerp(PAL.duskHorizon, dusk * .75); fog.lerp(PAL.duskFog, dusk * .55);
  const u = R.sky.material.uniforms;
  u.top.value.copy(top); u.horizon.value.copy(hor); u.bottom.value.copy(fog);
  scene.fog.color.copy(fog);
  scene.fog.near = lerp(90, 25, n); scene.fog.far = lerp(1100, 380, n);

  // trajetória do sol: nasce atrás à esquerda, põe-se à frente à direita
  const ang = (env.timeOfDay - 6) / 12 * Math.PI;
  const dir = new THREE.Vector3(-.55 * Math.cos(ang), Math.sin(ang), .75 * Math.cos(ang) - .55).normalize();
  u.sunDir.value.copy(dir); u.sunGlow.value = clamp((el + .15) * 3, 0, 1);
  u.sunColor.value.copy(lerpColor(PAL.sunDay, PAL.sunLow, clamp(1 - el * 2.5, 0, 1)));
  R.sun.position.copy(dir).multiplyScalar(1500);
  R.sun.material.opacity = clamp((el + .06) * 6, 0, 1);
  R.moon.position.copy(dir).multiplyScalar(-1500).setY(Math.max(250, -dir.y * 1500));
  R.moon.material.opacity = clamp(n * 1.2 - .1, 0, 1);
  R.stars.material.opacity = clamp(n * 1.3 - .3, 0, 1);

  const sunI = clamp(el * 2.2, 0, 1);
  R.sunLight.intensity = sunI * .95;
  R.sunLight.color.copy(lerpColor(PAL.sunDay, PAL.sunLow, clamp(1 - el * 2.5, 0, 1)));
  R.sunLight.position.copy(dir).multiplyScalar(120).add(new THREE.Vector3(0, 0, -30));
  R.sunLight.castShadow = sunI > .08;
  R.hemi.color.copy(lerpColor(PAL.hemiSkyDay, PAL.hemiSkyNight, n)).lerp(PAL.duskHorizon, dusk * .3);
  R.hemi.groundColor.copy(lerpColor(PAL.hemiGroundDay, PAL.hemiGroundNight, n));
  R.hemi.intensity = lerp(.62, .32, n);
  R.moonLight.intensity = n * .22;

  // faróis do veículo próprio
  const hb = .15 + n * 1.6;
  R.headL.intensity = R.headR.intensity = hb;
  R.headL.distance = R.headR.distance = lerp(45, 120, n);
  // facho visível no asfalto: discreto de dia (farol baixo/DRL), forte à noite
  R.egoBeam.material.opacity = .32 + n * .35;
  R.egoBeamCore.material.opacity = .22 + n * .3;

  // nuvens: brancas de dia, alaranjadas no pôr do sol, escuras à noite
  const cloudCol = lerpColor(C('#ffffff'), C('#2a3448'), n).lerp(C('#ffb487'), dusk * .7);
  for (const c of R.clouds) { c.material.color.copy(cloudCol); c.material.opacity = lerp(.92, .35, n); }
  R.reflectors.material.color.setScalar(lerp(.75, 1.6, n));
  for (const m of R.cityWindows || []) m.emissive.setScalar(clamp(n * 1.3 - .15, 0, 1));
  if (R.lampHeads) R.lampHeads.color.set(n > .25 ? 0xffe2a0 : 0x3a3d40);
}

/* ---------- câmeras ---------- */
function eye() {
  const truck = state.vehicle === 'truck';
  return { x: egoX() - (truck ? .55 : .42), y: truck ? 2.75 : 1.22, z: truck ? -7.2 + 7.2 : 0 };
}
let bobT = 0, shake = 0;
function updateCamera(dt) {
  // balanço da suspensão: cresce com a velocidade só até ~110 km/h (acima disso, mais balanço só parecia tremedeira)
  const e = eye(), sp = Math.min(state.speed, 110) / 100;
  bobT += dt * (2 + sp * 6);
  const calm = state.reduceMotion ? 0 : 1;
  shake = Math.max(0, shake - dt * 2.5);
  const by = (Math.sin(bobT * 1.7) * .006 + Math.sin(bobT * 4.3) * .003) * sp * calm + (Math.random() - .5) * shake * .05 * calm;
  const bx = Math.sin(bobT * .6) * .01 * sp * calm + (Math.random() - .5) * shake * .04 * calm;
  // pequenas correções do volante deslocam o veículo na faixa; a suspensão inclina a vista
  // (no modo volante o deslocamento já é o real, em egoOffset: o giro não desloca a vista de novo)
  const motorista = state.controle === 'volante' && !(state.level === 'intervention' && !state.degraded);
  const drift = motorista ? 0 : V.motion.steer * .012;
  camera.position.set(e.x + bx + drift, e.y + by, e.z);
  // o rumo do veículo (manobra para o acostamento) gira a vista suavemente para o lado
  camera.lookAt(e.x + bx * .3 + drift * 1.6 + Math.tan(world.heading) * 40, e.y - (state.vehicle === 'truck' ? 4.6 : 3.4), e.z - 40);
  camera.rotateZ(V.motion.roll);
  // depuração: VIGIA.world3d.camLivre = { pos: [x, y, z], alvo: [x, y, z] } troca a vista (null volta)
  const cl = V.world3d.camLivre;
  if (cl) { camera.position.set(...cl.pos); camera.lookAt(...cl.alvo); }
  const ex = egoX();
  if (R.ego) {
    R.ego.position.x = ex; R.ego.rotation.y = -world.heading;
    // lanternas traseiras: acesas à noite, fortes ao frear (vistas pelos retrovisores)
    const forca = state.luzFreio ? 1 : env.night > .3 ? .45 : .12;
    if (R.egoChama) { // tiro no escapamento: acende forte e apaga em ESTOURO.dura s
      const k = Math.max(0, 1 - (world.estouroT ?? 9) / V.ESTOURO.dura);
      R.egoChama.material.opacity = k; const s = R.egoChama.userData.size * (.6 + .8 * k); R.egoChama.scale.set(s, s, 1);
    }
    for (const m of R.egoTails || []) {
      m.material.color.setRGB(.25 + .75 * forca, .02 + (state.luzFreio ? .12 : 0), .02);
      m.userData.brilho.material.opacity = state.luzFreio ? 1 : forca * .5;
    }
  }
  R.headL.position.set(ex - .7, .75, -1.8); R.headR.position.set(ex + .7, .75, -1.8);
  const front = state.vehicle === 'truck' ? 1.3 : 1.0; // para-choque à frente do motorista
  R.egoBeam.position.set(ex, .03, -(front + 2 + 26));
  R.egoBeamCore.position.set(ex, .035, -(front + 2 + 13));
  R.headL.target.position.set(ex - .9, 0, -45); R.headR.target.position.set(ex + .6, 0, -45);
}

// Retângulos dos retrovisores fornecidos pelo desenho da cabine (cabin.js).
// Cada retrovisor é renderizado numa textura própria, em resolução reduzida e em quadros
// alternados (metade de cada vez), e copiado para a tela em todo quadro, invertido na horizontal.
const mirrorRT = {};
let blitCam;
function mirrorTarget(key, rect) {
  const pr = renderer.getPixelRatio() * .8, w = Math.max(16, Math.round(rect.w * pr)), h = Math.max(16, Math.round(rect.h * pr));
  let m = mirrorRT[key];
  if (!m) {
    const rt = new THREE.WebGLRenderTarget(w, h);
    const geo = new THREE.PlaneGeometry(2, 2);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); // espelho
    const quad = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: rt.texture, depthTest: false, depthWrite: false, toneMapped: false }));
    const sc = new THREE.Scene(); sc.add(quad);
    m = mirrorRT[key] = { rt, scene: sc, fresh: false };
    blitCam = blitCam || new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  if (m.rt.width !== w || m.rt.height !== h) { m.rt.setSize(w, h); m.fresh = false; }
  return m;
}
function renderMirror(key, cam, rect, pos, target) {
  const m = mirrorTarget(key, rect);
  cam.position.set(pos[0], pos[1], pos[2]); cam.lookAt(target[0], target[1], target[2]);
  cam.aspect = rect.w / rect.h; cam.updateProjectionMatrix();
  renderer.setRenderTarget(m.rt); renderer.render(scene, cam); renderer.setRenderTarget(null);
  m.fresh = true;
}
// A imagem sai 2 px maior que o vidro em cada lado; o excesso fica sob a carcaça, então
// arredondamentos de meio pixel ao sacudir nunca abrem fresta entre o reflexo e a moldura.
const OVERSCAN = 2;
function blitMirror(key, rect) {
  const m = mirrorRT[key]; if (!m || !m.fresh) return;
  const H = container.clientHeight, e = OVERSCAN;
  const x = rect.x - e, y = H - rect.y - rect.h - e, w = rect.w + e * 2, h = rect.h + e * 2;
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.render(m.scene, blitCam);
}

/* ---------- inicialização ---------- */
function init() {
  THREE = window.THREE;
  container = document.getElementById('view3d');
  if (!THREE) { fail('Three.js não carregou. Verifique a conexão ou a pasta vendor/.'); return; }
  try {
    glCanvas = document.getElementById('glCanvas');
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) { fail('WebGL indisponível neste navegador.'); return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = true;

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xb4c9d6, 90, 1100);
  camera = new THREE.PerspectiveCamera(50, 16 / 9, .1, 4000);
  rearCams = { center: new THREE.PerspectiveCamera(26, 3, .3, 4000), left: new THREE.PerspectiveCamera(24, .6, .3, 4000), right: new THREE.PerspectiveCamera(24, .6, .3, 4000), lowL: new THREE.PerspectiveCamera(48, 1.2, .3, 4000), lowR: new THREE.PerspectiveCamera(48, 1.2, .3, 4000) };

  R.hemi = new THREE.HemisphereLight(0xcfe4ff, 0x5a6b3c, .62); scene.add(R.hemi);
  R.sunLight = new THREE.DirectionalLight(0xfff5e2, .95);
  R.sunLight.shadow.mapSize.set(1024, 1024);
  Object.assign(R.sunLight.shadow.camera, { left: -45, right: 45, top: 60, bottom: -60, near: 1, far: 400 });
  R.sunLight.shadow.bias = -.0006;
  R.sunLight.target.position.set(0, 0, -30);
  scene.add(R.sunLight, R.sunLight.target);
  R.moonLight = new THREE.DirectionalLight(0x8aa6ff, 0); R.moonLight.position.set(-60, 120, 80); scene.add(R.moonLight);
  for (const k of ['headL', 'headR']) {
    const s = new THREE.SpotLight(0xfff2d6, 0, 95, .38, .6, 1.6);
    R[k] = s; scene.add(s, s.target);
  }

  buildSky(); buildTerrain(); buildLogoLargada(); buildRoadside(); buildEgo(); buildAnimals(); buildCity(); buildPostais(); buildPeople();
  // facho dos faróis no asfalto: amplo + núcleo mais intenso (como na visão 2D)
  const beamMat = o => new THREE.MeshBasicMaterial({ map: R.egoBeamTex, color: 0xdbe8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: o });
  R.egoBeamTex = egoBeamTex();
  R.egoBeam = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 52), beamMat(.2));
  R.egoBeamCore = new THREE.Mesh(new THREE.PlaneGeometry(4, 26), beamMat(.1));
  for (const b of [R.egoBeam, R.egoBeamCore]) { b.rotation.x = -Math.PI / 2; b.renderOrder = 2; scene.add(b); }
  V.on('vehicle', buildEgo);
  // Desempenho: compila agora os programas de tudo o que pode aparecer (cartões-postais, cidade),
  // em vez de na primeira vez que surgem na estrada (travava ~0,3 s ao chegar a Matipó).
  try {
    const ocultos = [];
    scene.traverse(o => { if (!o.visible) { ocultos.push(o); o.visible = true; } });
    renderer.compile(scene, camera);
    for (const o of ocultos) o.visible = false;
  } catch (e) { console.warn('VIGIA: pré-compilação dos shaders falhou', e); }
  V.on('pass', t => { if (t.rel > 25 && !t.contra) shake = Math.max(shake, (V.VEHICLE_TYPES[t.kind]?.heavy ? .5 : .18) * Math.min(1, t.rel / 80)); }); // contramão: sem sacudir
  new ResizeObserver(resize).observe(container);
  resize();
  warmUp();
  ready = true;
}
// Renderiza uma vez, fora da tela, com tudo visível (cidade, pessoas, placas, tipos de veículo),
// para compilar shaders e enviar texturas à GPU na abertura, e não no meio da viagem.
function warmUp() {
  const shown = [];
  const show = o => { if (!o.visible) { o.visible = true; shown.push(o); } };
  (R.scrollers || []).forEach(show); R.officers.forEach(show); R.peds.forEach(show);
  const extra = [];
  for (const kind of Object.keys(V.VEHICLE_TYPES)) for (const color of V.VEHICLE_TYPES[kind].colors.slice(0, 3)) {
    const v = { kind, color, cab: '#f4f4f2' }, g = (BUILDERS[kind] || BUILDERS.car)(v);
    Object.assign(g.userData, { kind, color, cab: v.cab }); marcarPintura(g, v);
    g.position.set(0, 0, -30); scene.add(g); extra.push(g);
  }
  for (const type of ['animals', 'noPassing', 'rest', 'belt', 'distance', 'vigia', 'pedestrian', 'busStop']) { const g = buildSign({ type }); g.position.z = -30; scene.add(g); extra.push(g); }
  const rt = new THREE.WebGLRenderTarget(64, 64);
  try { renderer.compile(scene, camera); renderer.setRenderTarget(rt); renderer.render(scene, camera); }
  finally { renderer.setRenderTarget(null); rt.dispose(); }
  shown.forEach(o => { o.visible = false; });
  // veículos pré-construídos vão para o reaproveitamento (pools), já prontos na GPU
  for (const g of extra) { scene.remove(g); if (g.userData.kind) { const pool = pools[g.userData.kind] || (pools[g.userData.kind] = []); if (pool.length < 12) pool.push(g); } }
}
function fail(msg) {
  failed = true;
  const el = document.getElementById('view3dError');
  if (el) { el.hidden = false; el.textContent = msg; }
}
function resize() {
  if (!renderer) return;
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // campo de visão mais aberto em telas estreitas
  camera.fov = w / h < 1.2 ? 62 : w / h < 1.6 ? 54 : 48;
  camera.updateProjectionMatrix();
  V.cabin?.resize(w, h);
}

let mirrorFrame = 0;
// Resolução adaptativa: se a máquina não segura ~60 quadros/s (um quadro que passa de 16,7 ms
// faz o navegador cair para 30, aos solavancos), a cena 3D baixa a escala de pixels em passos,
// até 0,7. Só desce: subir e descer alternadamente faria a imagem piscar de nitidez.
const QUAL = { media: 1 / 60, lento: 0, min: .7 };
function adaptarResolucao(dt) {
  if (!dt || dt > .2) return; // pausa, troca de aba ou primeiro quadro
  QUAL.media += (dt - QUAL.media) * .1;
  QUAL.lento = QUAL.media > 1 / 48 ? QUAL.lento + dt : 0;
  const pr = renderer.getPixelRatio();
  if (QUAL.lento > 1.5 && pr > QUAL.min + .01) {
    QUAL.lento = 0; QUAL.media = 1 / 60;
    renderer.setPixelRatio(Math.max(QUAL.min, Math.round((pr - .2) * 100) / 100)); resize();
  }
}
function render(dt) {
  if (!ready || failed || !V.vistaAtiva('3d')) return;
  adaptarResolucao(dt);
  const t = R.tex;
  t.asphalt.offset.y = (world.distance / ROAD_TILE) % 1;
  t.gravel.offset.y = (world.distance / 6) % 1;
  t.shoulder.offset.y = (world.distance / ROAD_TILE) % 1;
  t.grass.offset.y = (world.distance / 5) % 1;
  for (const c of R.clouds) { c.position.x += c.userData.drift * dt; if (c.position.x > 1400) c.position.x = -1400; }
  const med = V.medir;
  renderer.info.autoReset = false; renderer.info.reset(); // V.world3d.info(): totais do quadro (cena, sombras e retrovisores)
  med('3d:atualizar', () => { updateScrollers(); updateLogoLargada(); updateVehicles(dt); updateSigns(); updatePostais(); updateAnimals(dt, performance.now()); updatePeople(performance.now()); updateLighting(); updateCamera(dt); });

  const w = container.clientWidth, h = container.clientHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.shadowMap.needsUpdate = true;
  med('3d:cena', () => renderer.render(scene, camera));

  // retrovisores: metade atualizada por quadro (30 Hz cada), todos copiados para a tela
  const layout = V.cabin?.layout;
  if (layout && layout.mirrors) {
    const e = eye(), truck = state.vehicle === 'truck';
    const halfW = truck ? 1.38 : 1.0;
    const cx = egoX();
    // retrovisores acompanham o balanço vertical da cabine
    const bob = V.cabin.snap ? V.cabin.snap(V.motion.bob) : V.motion.bob; // o mesmo deslocamento da moldura
    const m = {}; for (const [k, r] of Object.entries(layout.mirrors)) m[k] = { ...r, y: r.y + bob };
    const odd = mirrorFrame & 1;
    const t0 = performance.now();
    R.farVeg.forEach(v => { v.visible = false; });
    // retrovisor interno fica no centro do veículo (não na posição do motorista)
    if (m.center && !odd) renderMirror('center', rearCams.center, m.center, [cx, e.y + .1, e.z + .4], [cx, e.y - .9, 60]);
    if (m.left && !odd) { const p = [cx - halfW - .25, e.y - .25, e.z - (truck ? .2 : .6)]; renderMirror('left', rearCams.left, m.left, p, [p[0] - 1.4, p[1] - 1.2, 60]); }
    if (m.lowL && !odd) { const p = [cx - halfW - .3, e.y - .6, e.z - .2]; renderMirror('lowL', rearCams.lowL, m.lowL, p, [p[0] - 4, 0, 24]); }
    if (m.right && odd) { const p = [cx + halfW + .25, e.y - .25, e.z - (truck ? .2 : .6)]; renderMirror('right', rearCams.right, m.right, p, [p[0] + 1.2, p[1] - 1.2, 60]); }
    if (m.lowR && odd) { const p = [cx + halfW + .3, e.y - .6, e.z - .2]; renderMirror('lowR', rearCams.lowR, m.lowR, p, [p[0] + 4, 0, 24]); }
    R.farVeg.forEach(v => { v.visible = true; });
    renderer.setScissorTest(true);
    for (const k of Object.keys(m)) blitMirror(k, m[k]);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    if (V.perf.on) V.perf.somar('3d:retrovisores', performance.now() - t0);
  }
  mirrorFrame++;
}

V.world3d = { init, render, resize, get falhou() { return failed; }, get cena() { return scene; }, // cena: só para diagnóstico
  get resolucao() { return renderer && renderer.getPixelRatio(); }, info: () => renderer && { ...renderer.info.render, programs: renderer.info.programs?.length },
  // diagnóstico: posição dos animais em relação ao motorista (z < 0 = à frente)
  animals: () => (R.animals || []).map(a => ({ kind: a.kind, x: +a.x.toFixed(1), z: +(-(a.S - world.distance)).toFixed(1), state: a.state, visible: a.g.visible })), get ready() { return ready; }, get failed() { return failed; } };
V.on('ready', init);
V.addRenderer(dt => render(dt), 'mundo3d');
})();
