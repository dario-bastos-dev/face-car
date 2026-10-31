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
const ROAD_W = 8.4, ROAD_TILE = 16.8;
function makeAsphalt() {
  return canvasTex(1024, 2048, (ctx, w, h) => {
    noiseFill(ctx, w, h, [78, 81, 84], 34, 7);
    const ppm = w / ROAD_W;
    const r = rng(11);
    // agregados e manchas
    for (let i = 0; i < 2600; i++) { ctx.fillStyle = `rgba(${r() < .5 ? 25 : 150},${r() < .5 ? 27 : 150},${r() < .5 ? 30 : 152},${.05 + r() * .12})`; ctx.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3); }
    for (let i = 0; i < 26; i++) { ctx.fillStyle = `rgba(20,22,24,${.04 + r() * .07})`; ctx.beginPath(); ctx.ellipse(r() * w, r() * h, 20 + r() * 90, 30 + r() * 180, r() * 3, 0, 7); ctx.fill(); }
    // trilhas de pneus mais escuras e polidas
    for (const lx of [1.15, 2.6, 5.8, 7.25]) {
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
    line(ROAD_W / 2 - .11, .12, '#e4ad35'); line(ROAD_W / 2 + .11, .12, '#e4ad35');
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

function buildTerrain() {
  R.tex = { asphalt: makeAsphalt(), gravel: makeGravel(), grass: makeGrass() };
  // Vai de BEHIND metros atrás até ~1040 m à frente: os retrovisores também enxergam pista e chão.
  const LEN = 1360, BEHIND = 320, cz = -LEN / 2 + BEHIND;
  R.tex.asphalt.repeat.set(1, LEN / ROAD_TILE);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, LEN), std(0xffffff, { map: R.tex.asphalt, roughness: .92 }));
  road.rotation.x = -Math.PI / 2; road.position.set(0, 0, cz); road.receiveShadow = true; scene.add(road);
  R.tex.gravel.repeat.set(1, LEN / 6);
  for (const side of [-1, 1]) {
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, LEN), std(0xffffff, { map: R.tex.gravel, roughness: 1 }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(side * (ROAD_W / 2 + 1.3), -.02, cz);
    if (side < 0) sh.scale.x = -1;
    sh.receiveShadow = true; scene.add(sh);
  }
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
const SCROLL = { uScrollD: { value: 0 }, uZoneRel: { value: new Float32Array(8) }, uZoneCity: { value: new Float32Array(8) }, uZoneN: { value: 1 } };
const ZONE_HALF = 45; // metade da faixa de transição entre cenários (ZONE_BLEND do núcleo)
const SCROLL_HEAD = `
uniform float uScrollD; uniform float uZoneRel[8]; uniform float uZoneCity[8]; uniform int uZoneN;
varying float vScrollFade;
float scrollZ(float zb) { return mod(zb + uScrollD - (${Z_FAR.toFixed(1)}), ${WRAP.toFixed(1)}) + (${Z_FAR.toFixed(1)}); }
float scrollCity(float s) {
  float c = uZoneCity[0], prev = c, st = -1e6;
  for (int k = 1; k < 8; k++) { if (k >= uZoneN) break; if (uZoneRel[k] <= s) { prev = uZoneCity[k - 1]; c = uZoneCity[k]; st = uZoneRel[k]; } }
  return s - st >= ${ZONE_HALF.toFixed(1)} ? c : prev;
}
float scrollKeep(float z) {
#if SCROLL_ZONE == 1
  return scrollCity(-z);
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
  { float zb = instanceMatrix[3][2], sz = scrollZ(zb), keep = scrollKeep(sz);
    ${p}.xyz = mix(instanceMatrix[3].xyz, ${p}.xyz, keep); ${p}.z += sz - zb; vScrollFade = scrollFade(sz); }`;
const ZONE_CODE = { city: 1, field: 2 };
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
    m.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.sx || 1, it.sy || 1, it.sz || 1));
    mesh.setMatrixAt(i, m);
    if (it.color && mesh.setColorAt) mesh.setColorAt(i, it.color);
  });
  mesh.castShadow = castShadow; mesh.receiveShadow = true; mesh.frustumCulled = false;
  if (castShadow) mesh.customDepthMaterial = scrollDepth(mode);
  mesh.userData = { zone };
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
function canopyParts(seed, lobes, top, bottom, light, dark) {
  const r = rng(seed), parts = [];
  const cL = C(light), cD = C(dark);
  for (const [ox, oy, oz, rad] of lobes) {
    const g = new THREE.IcosahedronGeometry(rad, 1); // detalhe 1: copa arredondada com poucos triângulos
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
function buildTreeGeos() {
  return {
    // árvore de copa larga
    broad: mergeParts([trunkPart(3.2, .32, .2, '#5a4634'),
      ...canopyParts(3, [[0, 4.6, 0, 2.3], [1.5, 4.1, .6, 1.7], [-1.4, 4.2, -.4, 1.8], [.3, 5.6, -.8, 1.6], [-.5, 3.7, 1.3, 1.5]], 7.2, 2.6, '#7fa34a', '#2c4a22')]),
    // árvore mais alta e estreita
    tall: mergeParts([trunkPart(4.4, .26, .16, '#5e4a38'),
      ...canopyParts(9, [[0, 5.6, 0, 1.8], [.6, 7, .2, 1.4], [-.5, 4.8, .4, 1.5], [.2, 8.1, -.2, 1.0]], 9.2, 3.8, '#86ab52', '#2f4f25')]),
    // eucalipto: tronco claro e copa alta
    eucal: mergeParts([trunkPart(9, .2, .1, '#b9b2a2'),
      ...canopyParts(17, [[0, 10, 0, 1.4], [.5, 11.3, .3, 1.1], [-.4, 9.2, -.3, 1.2], [.1, 12.2, 0, .8]], 13, 8, '#8fa86a', '#3e5a33')]),
    // arbusto baixo
    bush: mergeParts(canopyParts(23, [[0, .55, 0, .8], [.7, .45, .3, .6], [-.6, .45, -.2, .65], [.1, .9, .2, .5]], 1.4, 0, '#7a9c45', '#2a4320'))
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

  // vegetação
  const G = buildTreeGeos();
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
  scroller(G.bush, treeMat, bush, false, 'field');
  R.farVeg = [scroller(G.broad, treeMat, farBroad, false, 'field'), scroller(G.tall, treeMat, farTall, false, 'field'), scroller(G.eucal, treeMat, eucal, false, 'field')];

  // postes da rede elétrica à esquerda
  const poles = [], arms = [];
  for (let z = Z_FAR; z < Z_BACK; z += 52) { poles.push({ x: -16, y: 4.5, z }); arms.push({ x: -16, y: 8.6, z }); }
  scroller(new THREE.CylinderGeometry(.13, .18, 9, 6), lam('#8b8174'), poles, true);
  scroller(new THREE.BoxGeometry(2.4, .12, .12), lam('#6d655b'), arms);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2b2b2b });
  for (const dx of [-1.05, 0, 1.05]) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-16 + dx, 8.5, Z_BACK), new THREE.Vector3(-16 + dx, 8.5, -900)]);
    scene.add(new THREE.Line(g, wireMat));
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
  const mesh = scroller(geo, [side, side, roof, roof, side, side], items, false, 'city');
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
  scroller(houseGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), houses, false, 'city');
  buildingMesh(shops, 9, 7, 12, '#e3d5bd', '#33475a');       // comércio baixo
  buildingMesh(towersA, 16, 30, 14, '#cbbfae', '#2f4252');   // residencial
  buildingMesh(towersB, 13, 22, 13, '#9fb3c4', '#1f3346');   // escritório envidraçado
  buildingMesh(towersC, 18, 14, 13, '#d9cdb9', '#3b4c5c');   // bloco médio
  buildingMesh(towersD, 11, 42, 11, '#b8bcc1', '#26384a');   // torre alta
  const G = buildTreeGeos(), treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  scroller(G.broad, treeMat, parks, false, 'city');
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
    for (let i = 0; i < 8; i++) zebra.push({ x: -3.5 + i, y: .015, z: z + 7.5 });
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
const PASTURE = { min: -48, max: FENCE_X - 3 }; // faixa do pasto visível pelo para-brisa
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
function setVehicleLights(g, night, braking, hazard) {
  const u = g.userData;
  // faróis de quem vem na contramão: halo contido para não ofuscar a visão
  u.frontGlows.forEach(s => { s.material.opacity = .18 + night * .37; const k = .8 + night * .7; s.scale.set(s.userData.size * k, s.userData.size * k, 1); });
  u.tailGlows.forEach(s => { s.material.opacity = (braking ? .9 : night * .7) + (hazard ? .5 : 0); });
  u.tails.forEach(t => t.material.color.copy(t.userData.base).multiplyScalar(braking || night > .3 ? 1 : .55));
  u.beam.material.opacity = night * .3;
}

const pools = {}; // modelos reaproveitados por tipo
const active = new Map();
function acquire(key, v) {
  let g = active.get(key);
  if (g && g.userData.kind === v.kind && g.userData.color === v.color) return g;
  if (g) release(key);
  const pool = pools[v.kind] || (pools[v.kind] = []);
  g = pool.find(p => p.userData.color === v.color);
  if (g) pool.splice(pool.indexOf(g), 1);
  else {
    g = (BUILDERS[v.kind] || BUILDERS.car)(v);
    g.userData.kind = v.kind; g.userData.color = v.color;
  }
  g.visible = true; scene.add(g); active.set(key, g);
  return g;
}
function release(key) {
  const g = active.get(key); if (!g) return;
  scene.remove(g); active.delete(key);
  const pool = pools[g.userData.kind] || (pools[g.userData.kind] = []); if (pool.length < 6) pool.push(g);
}

function updateVehicles(dt) {
  const night = env.night, seen = new Set();
  for (const t of world.traffic) {
    if (t.z > 700 || t.z < -330) continue;
    const key = 'o' + t.id; seen.add(key);
    const g = acquire(key, t);
    g.position.set(V.ROAD.oppositeLaneX, 0, -t.z);
    g.rotation.y = Math.PI;
    setVehicleLights(g, night, false, false);
    spin(g, (t.kmh / 3.6) * dt);
  }
  for (const [key, v] of [['lead', world.lead], ['follow', world.follower]]) {
    if (!v) continue; seen.add(key);
    const g = acquire(key, v);
    g.position.set(V.ROAD.egoLaneX, 0, -v.z);
    g.rotation.y = 0;
    const braking = key === 'lead' && v.prevKmh != null && v.kmh < v.prevKmh - .02;
    v.prevKmh = v.kmh;
    setVehicleLights(g, night, braking, false);
    spin(g, (v.kmh / 3.6) * dt);
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
const BACK_SIDE = new Set(['animals', 'noPassing', 'pedestrian']); // placas pequenas também no sentido oposto (vemos o verso)
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
    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.8, .62, 4.5), body); lower.position.set(0, .66, 1.3); g.add(lower);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, .6, 2.2), [std('#121a22', { metalness: .8, roughness: .1 }), std('#121a22', { metalness: .8, roughness: .1 }), body, body, body, body]); top.position.set(0, 1.27, 1.4); g.add(top);
  }
  g.position.x = V.ROAD.egoLaneX;
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
  return { x: V.ROAD.egoLaneX - (truck ? .55 : .42), y: truck ? 2.75 : 1.22, z: truck ? -7.2 + 7.2 : 0 };
}
let bobT = 0, shake = 0;
function updateCamera(dt) {
  const e = eye(), sp = state.speed / 100;
  bobT += dt * (2 + sp * 6);
  const calm = state.reduceMotion ? 0 : 1;
  shake = Math.max(0, shake - dt * 2.5);
  const by = (Math.sin(bobT * 1.7) * .006 + Math.sin(bobT * 4.3) * .003) * sp * calm + (Math.random() - .5) * shake * .05 * calm;
  const bx = Math.sin(bobT * .6) * .01 * sp * calm + (Math.random() - .5) * shake * .04 * calm;
  // pequenas correções do volante deslocam o veículo na faixa; a suspensão inclina a vista
  const drift = V.motion.steer * .012;
  camera.position.set(e.x + bx + drift, e.y + by, e.z);
  camera.lookAt(e.x + bx * .3 + drift * 1.6, e.y - (state.vehicle === 'truck' ? 4.6 : 3.4), e.z - 40);
  camera.rotateZ(V.motion.roll);
  R.headL.position.set(V.ROAD.egoLaneX - .7, .75, -1.8); R.headR.position.set(V.ROAD.egoLaneX + .7, .75, -1.8);
  const front = state.vehicle === 'truck' ? 1.3 : 1.0; // para-choque à frente do motorista
  R.egoBeam.position.set(V.ROAD.egoLaneX, .03, -(front + 2 + 26));
  R.egoBeamCore.position.set(V.ROAD.egoLaneX, .035, -(front + 2 + 13));
  R.headL.target.position.set(V.ROAD.egoLaneX - .9, 0, -45); R.headR.target.position.set(V.ROAD.egoLaneX + .6, 0, -45);
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

  buildSky(); buildTerrain(); buildRoadside(); buildEgo(); buildAnimals(); buildCity(); buildPeople();
  // facho dos faróis no asfalto: amplo + núcleo mais intenso (como na visão 2D)
  const beamMat = o => new THREE.MeshBasicMaterial({ map: R.egoBeamTex, color: 0xdbe8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: o });
  R.egoBeamTex = egoBeamTex();
  R.egoBeam = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 52), beamMat(.2));
  R.egoBeamCore = new THREE.Mesh(new THREE.PlaneGeometry(4, 26), beamMat(.1));
  for (const b of [R.egoBeam, R.egoBeamCore]) { b.rotation.x = -Math.PI / 2; b.renderOrder = 2; scene.add(b); }
  V.on('vehicle', buildEgo);
  V.on('pass', t => { if (V.VEHICLE_TYPES[t.kind]?.heavy) shake = .9; else shake = Math.max(shake, .35); });
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
    const g = (BUILDERS[kind] || BUILDERS.car)({ kind, color, cab: '#f4f4f2' }); g.userData.kind = kind; g.userData.color = color;
    g.position.set(0, 0, -30); scene.add(g); extra.push(g);
  }
  for (const type of ['animals', 'noPassing', 'rest', 'belt', 'distance', 'vigia', 'pedestrian', 'busStop']) { const g = buildSign({ type }); g.position.z = -30; scene.add(g); extra.push(g); }
  const rt = new THREE.WebGLRenderTarget(64, 64);
  try { renderer.compile(scene, camera); renderer.setRenderTarget(rt); renderer.render(scene, camera); }
  finally { renderer.setRenderTarget(null); rt.dispose(); }
  shown.forEach(o => { o.visible = false; });
  // veículos pré-construídos vão para o reaproveitamento (pools), já prontos na GPU
  for (const g of extra) { scene.remove(g); if (g.userData.kind) { const pool = pools[g.userData.kind] || (pools[g.userData.kind] = []); if (pool.length < 6) pool.push(g); } }
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
function render(dt) {
  if (!ready || failed || state.viewMode !== '3d') return;
  const t = R.tex;
  t.asphalt.offset.y = (world.distance / ROAD_TILE) % 1;
  t.gravel.offset.y = (world.distance / 6) % 1;
  t.grass.offset.y = (world.distance / 5) % 1;
  for (const c of R.clouds) { c.position.x += c.userData.drift * dt; if (c.position.x > 1400) c.position.x = -1400; }
  updateScrollers(); updateVehicles(dt); updateSigns(); updateAnimals(dt, performance.now()); updatePeople(performance.now()); updateLighting(); updateCamera(dt);

  const w = container.clientWidth, h = container.clientHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);

  // retrovisores: metade atualizada por quadro (30 Hz cada), todos copiados para a tela
  const layout = V.cabin?.layout;
  if (layout && layout.mirrors) {
    const e = eye(), truck = state.vehicle === 'truck';
    const halfW = truck ? 1.38 : 1.0;
    const cx = V.ROAD.egoLaneX;
    // retrovisores acompanham o balanço vertical da cabine
    const bob = V.cabin.snap ? V.cabin.snap(V.motion.bob) : V.motion.bob; // o mesmo deslocamento da moldura
    const m = {}; for (const [k, r] of Object.entries(layout.mirrors)) m[k] = { ...r, y: r.y + bob };
    const odd = mirrorFrame & 1;
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
  }
  mirrorFrame++;
}

V.world3d = { init, render, info: () => renderer && { ...renderer.info.render, programs: renderer.info.programs?.length },
  // diagnóstico: posição dos animais em relação ao motorista (z < 0 = à frente)
  animals: () => (R.animals || []).map(a => ({ kind: a.kind, x: +a.x.toFixed(1), z: +(-(a.S - world.distance)).toFixed(1), state: a.state, visible: a.g.visible })), get ready() { return ready; }, get failed() { return failed; } };
V.on('ready', init);
V.addRenderer(dt => render(dt));
})();
