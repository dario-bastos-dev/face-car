/* Monitoramento do motorista: webcam (só prévia local, sem gravação) e sobreposição.
 *
 * - Com o scanner (ia.js) ativo, as métricas são REAIS: vêm do extrator da Parte 1
 *   e do estimador da Parte 2, e a malha do rosto do MediaPipe é desenhada aqui.
 *   No modo "invisível" o scanner continua rodando, mas nada é desenhado.
 * - Sem o scanner, as métricas são simuladas a partir do nível de alerta. */
(() => {
'use strict';
const V = window.VIGIA;
const { state, clamp, lerp } = V;
const $ = id => document.getElementById(id);

const M = V.monitor = { cameraActive: false, external: false, setMetrics, startCamera, stopCamera };
let stream = null, canvas, ctx, W = 0, H = 0, dpr = 1;
const m = { eyesOpen: 1, headPitch: 0, headYaw: 0, yawn: 0, perclos: 4, fatigue: 8, confidence: .97, face: { x: .33, y: .2, w: .34, h: .52 } };
let blinkT = 0, blinkPhase = 0, externalAt = 0, eyesBase = 1;

function setMetrics(data) {
  M.external = true; externalAt = performance.now();
  Object.assign(m, data);
  if (data.face) m.face = { ...m.face, ...data.face };
}

async function startCamera() {
  $('camWarning').hidden = $('camWarning3d').hidden = true;
  if (stream) { stopCamera(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { camError('Abra pelo endereço http://localhost:8000 (ou HTTPS) em um navegador compatível.'); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    $('cameraFeed').srcObject = stream;
    for (const id of ['cameraFeed3d']) { $(id).srcObject = stream; $(id).play().catch(() => {}); }
    await $('cameraFeed').play().catch(() => {});
    M.cameraActive = true;
    $('monitorCard').classList.add('live');
    $('camStatus').textContent = 'AO VIVO'; setSwitches(true);
    V.log('Webcam ativada, apenas prévia local; sem gravação', 'camera');
    stream.getVideoTracks().forEach(t => t.onended = stopCamera);
  } catch (e) {
    camError(e.name === 'NotAllowedError' ? 'Permissão negada. Autorize a câmera na barra do navegador.' : e.name === 'NotFoundError' ? 'Nenhuma câmera encontrada no dispositivo.' : 'Falha ao abrir câmera: ' + e.message);
    setSwitches(false);
  }
}
function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('cameraFeed').srcObject = null; $('cameraFeed3d').srcObject = null; M.cameraActive = false;
  $('monitorCard').classList.remove('live');
  $('camStatus').textContent = 'SIMULAÇÃO'; setSwitches(false);
  V.emit('cameraOff'); // o scanner (ia.js) para junto com a câmera
}
// interruptores da câmera na visão 2D e na cabine 3D ficam sempre sincronizados
function setSwitches(on) { for (const id of ['cameraBtn', 'cameraBtn3d']) $(id).checked = on; }
function camError(msg) {
  for (const id of ['camWarning', 'camWarning3d']) { $(id).textContent = msg; $(id).hidden = false; }
  V.log('Webcam: ' + msg, 'error');
}

// Métricas simuladas por nível (alvo para onde os valores convergem suavemente).
const TARGET = {
  normal: { eyes: 1, pitch: 0, yawn: 0, perclos: 5, fatigue: 10 },
  attention: { eyes: .72, pitch: 9, yawn: .55, perclos: 22, fatigue: 48 },
  critical: { eyes: .38, pitch: 18, yawn: .2, perclos: 46, fatigue: 74 },
  intervention: { eyes: .05, pitch: 30, yawn: 0, perclos: 82, fatigue: 95 },
  degraded: { eyes: 1, pitch: 0, yawn: 0, perclos: 5, fatigue: 10 }
};
function simulate(dt, t) {
  if (M.external && performance.now() - externalAt < 2000) return;
  M.external = false;
  const T = TARGET[V.effectiveLevel()], k = clamp(dt * 1.6, 0, 1);
  // piscadas naturais
  blinkT -= dt;
  if (blinkT < 0) { blinkPhase = .18; blinkT = V.effectiveLevel() === 'normal' ? 2.5 + Math.random() * 3 : 1.2 + Math.random() * 1.5; }
  blinkPhase = Math.max(0, blinkPhase - dt);
  const blink = blinkPhase > 0 ? Math.sin(blinkPhase / .18 * Math.PI) : 0;
  const yawnWave = T.yawn ? Math.max(0, Math.sin(t / 1400)) * T.yawn : 0;
  eyesBase = lerp(eyesBase, T.eyes, k);
  m.eyesOpen = eyesBase * (1 - blink * .95);
  m.headPitch = lerp(m.headPitch, T.pitch + Math.sin(t / 900) * (T.pitch ? 3 : .8), k);
  m.headYaw = Math.sin(t / 2300) * 4;
  m.yawn = lerp(m.yawn, yawnWave, k * 2);
  m.perclos = lerp(m.perclos, T.perclos, k * .5);
  m.fatigue = lerp(m.fatigue, T.fatigue, k * .5);
  m.confidence = .95 + Math.sin(t / 700) * .02;
  m.face = { x: .33 + Math.sin(t / 1900) * .015, y: .18 + m.headPitch / 300, w: .34, h: .52 };
}

/* ---------- desenho ---------- */
// Resolução fixa 4:3: a sobreposição é desenhada mesmo com o cartão oculto,
// porque o cartão da cabine 3D copia esta imagem.
function resize() {
  W = 320; H = 240; dpr = 2;
  canvas.width = W * dpr; canvas.height = H * dpr;
}
function corner(c, x, y, w, h, len) {
  c.beginPath();
  c.moveTo(x, y + len); c.lineTo(x, y); c.lineTo(x + len, y);
  c.moveTo(x + w - len, y); c.lineTo(x + w, y); c.lineTo(x + w, y + len);
  c.moveTo(x + w, y + h - len); c.lineTo(x + w, y + h); c.lineTo(x + w - len, y + h);
  c.moveTo(x + len, y + h); c.lineTo(x, y + h); c.lineTo(x, y + h - len);
  c.stroke();
}
// silhueta quando a câmera está desligada (a demonstração funciona sem webcam)
function silhouette(c, f) {
  const cx = (f.x + f.w / 2) * W, cy = (f.y + f.h * .45) * H, rw = f.w * W * .42, rh = f.h * H * .5;
  c.fillStyle = 'rgba(120,160,200,.10)';
  c.beginPath(); c.ellipse(cx, H * 1.05, W * .34, H * .3, 0, 0, 7); c.fill();
  c.fillStyle = 'rgba(140,180,220,.14)';
  c.beginPath(); c.ellipse(cx, cy, rw, rh, 0, 0, 7); c.fill();
}
function eyeShape(c, x, y, w, open, color) {
  const h = w * .42 * open;
  c.strokeStyle = color; c.lineWidth = 1.4;
  c.beginPath(); c.moveTo(x - w / 2, y); c.quadraticCurveTo(x, y - h, x + w / 2, y); c.quadraticCurveTo(x, y + h, x - w / 2, y); c.stroke();
  c.fillStyle = color;
  const pts = [[-.5, 0], [-.22, -h / w * .85], [.22, -h / w * .85], [.5, 0], [.22, h / w * .85], [-.22, h / w * .85]];
  for (const [px, py] of pts) { c.beginPath(); c.arc(x + px * w, y + py * w, 1.8, 0, 7); c.fill(); }
}
// Malha real do MediaPipe. A imagem da câmera é espelhada (como um espelho), então x também.
function drawReal(c, color) {
  const ia = V.ia, r = ia.ultimo;
  if (!ia.visivel) return; // modo invisível: o scanner segue rodando, sem desenho
  const pts = r?.pontos, idx = ia.indices;
  const P = i => [(1 - pts[i][0]) * W, pts[i][1] * H];
  if (!pts) {
    c.fillStyle = 'rgba(3,10,20,.7)'; c.fillRect(W / 2 - 80, H / 2 - 12, 160, 24);
    c.fillStyle = '#ffc44d'; c.font = '800 11px Inter, system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText(ia.carregando ? 'CARREGANDO MODELO…' : 'ROSTO NÃO DETECTADO', W / 2, H / 2 + 4);
    return;
  }
  const contorno = (nome, cor, largura, fechar = true) => {
    c.strokeStyle = cor; c.lineWidth = largura; c.beginPath();
    idx[nome].forEach((i, n) => (n ? c.lineTo : c.moveTo).call(c, ...P(i)));
    if (fechar) c.closePath(); c.stroke();
  };
  contorno('contorno_rosto', 'rgba(0,200,255,.75)', 1.2);
  for (const nome of ['contorno_olho_esquerdo', 'contorno_olho_direito', 'contorno_labios_externo', 'contorno_labios_interno']) contorno(nome, color, 1.1);
  c.strokeStyle = '#ff78ff';
  for (const nome of ['iris_esquerda', 'iris_direita']) {
    const [centro, ...borda] = idx[nome].map(P);
    const raio = borda.reduce((s, p) => s + Math.hypot(p[0] - centro[0], p[1] - centro[1]), 0) / borda.length;
    c.beginPath(); c.arc(centro[0], centro[1], Math.max(1, raio), 0, 7); c.stroke();
  }
  c.fillStyle = '#3ddc84';
  for (const i of [...idx.olho_esquerdo, ...idx.olho_direito]) { const [x, y] = P(i); c.fillRect(x - 1.5, y - 1.5, 3, 3); }
  // direção da cabeça a partir da ponta do nariz (pitch positivo = cabeça baixa)
  if (r.registro.pitch !== null) {
    const [x0, y0] = P(idx.ponta_nariz);
    c.strokeStyle = '#ffdc00'; c.lineWidth = 2; c.beginPath(); c.moveTo(x0, y0);
    c.lineTo(x0 - r.registro.yaw * 1.2, y0 + r.registro.pitch * 1.4); c.stroke();
  }
  // caixa e rótulos
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const i of idx.contorno_rosto) { const [x, y] = P(i); x0 = Math.min(x0, x / W); y0 = Math.min(y0, y / H); x1 = Math.max(x1, x / W); y1 = Math.max(y1, y / H); }
  c.strokeStyle = color; c.lineWidth = 2; corner(c, x0 * W - 6, y0 * H - 6, (x1 - x0) * W + 12, (y1 - y0) * H + 12, 12);
  c.font = '700 10px Inter, system-ui, sans-serif'; c.fillStyle = color; c.textAlign = 'left';
  c.fillText(`ROSTO · CONF. ${Math.round(r.registro.confianca * 100)}%`, x0 * W - 6, y0 * H - 11);
  const est = r.estado || 'DEGRADADO';
  const lab = { NORMAL: 'MOTORISTA ATENTO', ATENCAO: 'SINAIS DE FADIGA', ALERTA: 'ALERTA DE SONOLÊNCIA', INTERVENCAO: 'INTERVENÇÃO', DEGRADADO: 'COLETANDO EVIDÊNCIA…' }[est];
  c.font = '800 10px Inter, system-ui, sans-serif';
  const tw = c.measureText(lab).width + 16;
  c.fillStyle = 'rgba(3,10,20,.75)'; c.beginPath(); c.roundRect ? c.roundRect(W / 2 - tw / 2, H - 26, tw, 19, 9) : c.rect(W / 2 - tw / 2, H - 26, tw, 19); c.fill();
  c.fillStyle = color; c.textAlign = 'center'; c.fillText(lab, W / 2, H - 13);
}
function realBars() {
  const r = V.ia.ultimo, reg = r?.registro, est = r?.estimativa;
  const f = (v, k = 1, suf = '') => v == null ? '—' : Math.round(v * k) + suf;
  const olhos = r?.abertura;
  setBar('mEyes', (olhos ?? 0) * 100, f(olhos, 100, '%'), olhos == null ? 'warn' : olhos < .4 ? 'bad' : olhos < .75 ? 'warn' : 'ok');
  const p = reg?.pitch;
  setBar('mHead', clamp((p ?? 0) / 35 * 100, 0, 100), f(p, 1, '°'), p == null ? 'warn' : p > 20 ? 'bad' : p > 8 ? 'warn' : 'ok');
  const pc = est?.perclos;
  setBar('mPerclos', (pc ?? 0) * 100, f(pc, 100, '%'), pc == null ? 'warn' : pc > .4 ? 'bad' : pc > .15 ? 'warn' : 'ok');
  const ix = est?.indice;
  setBar('mFatigue', ix ?? 0, f(ix), ix == null ? 'warn' : ix > 65 ? 'bad' : ix > 35 ? 'warn' : 'ok');
  $('monitorSource').textContent = 'IA REAL · MEDIAPIPE' + (V.ia.visivel ? '' : ' · OCULTO');
  $('monitorSource').classList.add('real');
}
function draw(dt, t) {
  if (!canvas || !W) return;
  const c = ctx, lvl = V.effectiveLevel();
  const color = lvl === 'normal' || lvl === 'degraded' ? '#38f0b0' : lvl === 'attention' ? '#ffc44d' : '#ff5a4f';
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  if (V.ia?.ativo) { drawReal(c, color); realBars(); return; }
  if (!state.paused) simulate(dt, t);
  const f = m.face, fx = f.x * W, fy = f.y * H, fw = f.w * W, fh = f.h * H;
  if (!M.cameraActive) silhouette(c, f);
  // grade de varredura sutil
  c.fillStyle = 'rgba(80,200,255,.05)';
  const scan = (t / 12) % H; c.fillRect(0, scan, W, 2);
  // caixa do rosto
  c.strokeStyle = color; c.lineWidth = 2; c.shadowColor = color; c.shadowBlur = 8;
  corner(c, fx, fy, fw, fh, Math.min(fw, fh) * .18); c.shadowBlur = 0;
  c.font = '700 10px Inter, system-ui, sans-serif'; c.fillStyle = color; c.textAlign = 'left';
  c.fillText(`ROSTO ${Math.round(m.confidence * 100)}%`, fx, fy - 6);
  // olhos
  const ey = fy + fh * .4 + m.headPitch * .4, ew = fw * .2;
  eyeShape(c, fx + fw * .3, ey, ew, clamp(m.eyesOpen, .04, 1), color);
  eyeShape(c, fx + fw * .7, ey, ew, clamp(m.eyesOpen, .04, 1), color);
  // boca (bocejo)
  const my = fy + fh * .78 + m.headPitch * .3, mw = fw * .22, mh = 2 + m.yawn * fh * .14;
  c.strokeStyle = color; c.lineWidth = 1.4; c.beginPath(); c.ellipse(fx + fw / 2, my, mw / 2, mh / 2, 0, 0, 7); c.stroke();
  // eixo de orientação da cabeça
  const nx = fx + fw / 2, ny = fy + fh * .55;
  c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(nx, ny); c.lineTo(nx + m.headYaw * 2, ny + m.headPitch * 1.6 + 18); c.stroke();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(nx, ny, 2.5, 0, 7); c.fill();
  // rótulo de estado
  const labels = { normal: 'MOTORISTA ATENTO', attention: 'SINAIS DE FADIGA', critical: 'OLHOS SEMICERRADOS', intervention: 'OLHOS FECHADOS · CABEÇA BAIXA', degraded: 'SEM SINAL DA IA' };
  const lab = labels[lvl];
  c.font = '800 10px Inter, system-ui, sans-serif';
  const tw = c.measureText(lab).width + 16;
  c.fillStyle = 'rgba(3,10,20,.75)'; c.beginPath(); c.roundRect ? c.roundRect(W / 2 - tw / 2, H - 26, tw, 19, 9) : c.rect(W / 2 - tw / 2, H - 26, tw, 19); c.fill();
  c.fillStyle = color; c.textAlign = 'center'; c.fillText(lab, W / 2, H - 13);

  // métricas no cartão
  setBar('mEyes', m.eyesOpen * 100, Math.round(m.eyesOpen * 100) + '%', m.eyesOpen < .4 ? 'bad' : m.eyesOpen < .75 ? 'warn' : 'ok');
  setBar('mHead', clamp(m.headPitch / 35 * 100, 0, 100), Math.round(m.headPitch) + '°', m.headPitch > 20 ? 'bad' : m.headPitch > 8 ? 'warn' : 'ok');
  setBar('mPerclos', m.perclos, Math.round(m.perclos) + '%', m.perclos > 40 ? 'bad' : m.perclos > 15 ? 'warn' : 'ok');
  setBar('mFatigue', m.fatigue, Math.round(m.fatigue), m.fatigue > 70 ? 'bad' : m.fatigue > 35 ? 'warn' : 'ok');
  $('monitorSource').textContent = M.external ? 'IA CONECTADA' : 'MÉTRICAS SIMULADAS';
  $('monitorSource').classList.toggle('real', M.external);
}
const barCache = {};
function setBar(id, pct, text, cls) {
  const key = Math.round(pct) + text + cls; if (barCache[id] === key) return; barCache[id] = key;
  // cartão principal + cópias (ex.: cartão da cabine 3D com data-mirror)
  for (const el of [$(id), ...document.querySelectorAll(`[data-mirror="${id}"]`)]) {
    el.querySelector('i').style.width = clamp(pct, 2, 100) + '%';
    el.querySelector('b').textContent = text; el.dataset.state = cls;
  }
}

V.on('ready', () => {
  canvas = $('monitorOverlay'); ctx = canvas.getContext('2d');
  resize();
  for (const id of ['cameraBtn', 'cameraBtn3d']) $(id).onchange = e => e.target.checked ? startCamera() : stopCamera();
});
V.addRenderer(draw);
})();

/* Cópia compacta para a cabine 3D: vídeo + sobreposição + métricas. */
(() => {
const V = window.VIGIA, $ = id => document.getElementById(id);
let ctx, w = 0, h = 0;
V.on('ready', () => {
  const cv = $('ccOverlay'); ctx = cv.getContext('2d');
  new ResizeObserver(() => { w = cv.clientWidth; h = cv.clientHeight; const d = Math.min(devicePixelRatio || 1, 2); cv.width = w * d; cv.height = h * d; }).observe(cv);
  $('ccView').onclick = () => V.monitor.cameraActive ? V.monitor.stopCamera() : V.monitor.startCamera();
});
V.addRenderer(() => {
  if (V.state.viewMode !== '3d' || !ctx || !w) return;
  const src = $('monitorOverlay');
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (src.width) ctx.drawImage(src, 0, 0, ctx.canvas.width, ctx.canvas.height);
  const live = V.monitor.cameraActive;
  $('cockpitCam').classList.toggle('live', live);
  const st = live ? 'AO VIVO' : 'SIMULAÇÃO';
  if ($('ccStatus').dataset.s !== st) { $('ccStatus').dataset.s = st; $('ccStatus').innerHTML = '<i></i>' + st; }
  const srcLabel = V.monitor.external ? 'IA CONECTADA' : 'MÉTRICAS SIMULADAS';
  if ($('ccSource').textContent !== srcLabel) { $('ccSource').textContent = srcLabel; $('ccSource').classList.toggle('real', V.monitor.external); }
});
})();
