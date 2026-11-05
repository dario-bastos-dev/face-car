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
const m = { eyesOpen: 1, headPitch: 0, headYaw: 0, mouth: .04, perclos: 4, fatigue: 8, confidence: .97, face: { x: .33, y: .2, w: .34, h: .52 } };
let blinkT = 0, blinkPhase = 0, externalAt = 0, eyesBase = 1;
// Abertura da boca (abertura_boca do contrato metricas.v1: altura interna dos lábios / largura).
// Boca aberta acima do limiar de config/analise.json (rosto.abertura_boca_aberta); a barra
// chega a 100% no dobro dele. Com o scanner, o bocejo vem do monitor do rosto (ia.js); aqui
// fica só o da simulação, com os mesmos valores padrão.
const BOCEJO_LIMIAR = .4, BOCEJO_MIN_MS = 1500;
let bocaDesde = 0, bocejoSimulado = false;
function bocejo(v) {
  const agora = performance.now();
  if (v == null || v <= BOCEJO_LIMIAR) { bocaDesde = 0; bocejoSimulado = false; return false; }
  if (!bocaDesde) bocaDesde = agora;
  if (agora - bocaDesde >= BOCEJO_MIN_MS) bocejoSimulado = true;
  return bocejoSimulado;
}
function mouthBar(v, yawn, limiar = BOCEJO_LIMIAR) {
  const ref = limiar * 2;
  setBar('mMouth', clamp((v ?? 0) / ref * 100, 0, 100), v == null ? '—' : Math.round(clamp(v / ref, 0, 1) * 100) + '%',
    v == null ? 'warn' : yawn ? 'bad' : v > limiar ? 'warn' : 'ok');
}
function arrow(c, x0, y0, x1, y1, color, width) {
  const a = Math.atan2(y1 - y0, x1 - x0), len = Math.hypot(x1 - x0, y1 - y0), head = Math.min(7, len * .35);
  if (len < 2) return;
  c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
  c.moveTo(x1, y1); c.lineTo(x1 - head * Math.cos(a - .5), y1 - head * Math.sin(a - .5));
  c.moveTo(x1, y1); c.lineTo(x1 - head * Math.cos(a + .5), y1 - head * Math.sin(a + .5));
  c.stroke(); c.lineCap = 'butt';
}
// Selo "BOCEJO" logo abaixo do rosto.
function yawnTag(c, cx, y) {
  c.font = '800 10px Inter, system-ui, sans-serif';
  const tw = c.measureText('BOCEJO').width + 16; y = Math.min(y, H - 52);
  c.fillStyle = 'rgba(60,8,8,.85)'; c.beginPath(); c.roundRect ? c.roundRect(cx - tw / 2, y, tw, 18, 9) : c.rect(cx - tw / 2, y, tw, 18); c.fill();
  c.fillStyle = '#ff5a4f'; c.textAlign = 'center'; c.fillText('BOCEJO', cx, y + 12.5); c.textAlign = 'left';
}

function setMetrics(data) {
  M.external = true; externalAt = performance.now();
  Object.assign(m, data);
  if (data.face) m.face = { ...m.face, ...data.face };
}

async function startCamera() {
  $('camWarning').hidden = true;
  if (stream) { stopCamera(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { camError('Abra pelo endereço http://localhost:8000 (ou HTTPS) em um navegador compatível.'); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    $('cameraFeed').srcObject = stream;
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
// Troca a câmera sem desligar o scanner: abre a nova antes de fechar a atual.
async function trocarCamera(deviceId) {
  const novo = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } }
    : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  const antigo = stream;
  stream = novo;
  $('cameraFeed').srcObject = novo;
  await $('cameraFeed').play().catch(() => {});
  novo.getVideoTracks().forEach(t => t.onended = stopCamera);
  antigo?.getTracks().forEach(t => { t.onended = null; t.stop(); });
}

/* Infravermelho: usa o sensor IR quando o navegador enxerga uma câmera com "IR" ou
 * "infra" no nome; senão, aplica só um filtro visual (monocromático) sobre a webcam comum.
 * Muitas câmeras IR de notebook (Windows Hello) não são liberadas para o navegador. */
let rgbDeviceId = null;
async function setIR(on) {
  const card = $('monitorCard');
  if (!on) {
    card.classList.remove('ir', 'ir-real');
    if (rgbDeviceId !== null) { const id = rgbDeviceId; rgbDeviceId = null; if (stream) await trocarCamera(id || null).catch(() => {}); }
    V.log('Câmera: imagem normal', 'camera');
    return;
  }
  const cams = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || []).filter(d => d.kind === 'videoinput');
  const ir = cams.find(d => /\bir\b|infra|infrared/i.test(d.label));
  if (stream && ir) {
    try {
      rgbDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId || '';
      await trocarCamera(ir.deviceId);
      card.classList.add('ir-real');
      V.log('Câmera infravermelha em uso: ' + ir.label, 'camera');
      return;
    } catch (e) { rgbDeviceId = null; V.log('Câmera infravermelha não abriu (' + e.message + '); usando filtro visual', 'error'); }
  }
  card.classList.add('ir');
  const nomes = cams.map(d => d.label).filter(Boolean);
  V.log(!stream ? 'Infravermelho: ligue a câmera para procurar um sensor IR; por enquanto, filtro visual'
    : `Nenhuma câmera infravermelha disponível para o navegador (câmeras: ${nomes.join(', ') || 'sem nome'}); usando filtro visual`, 'camera');
}

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (rgbDeviceId !== null) { rgbDeviceId = null; $('monitorCard').classList.remove('ir-real'); $('irBtn').checked = false; }
  $('cameraFeed').srcObject = null; M.cameraActive = false;
  $('monitorCard').classList.remove('live');
  $('camStatus').textContent = 'SIMULAÇÃO'; setSwitches(false);
  V.emit('cameraOff'); // o scanner (ia.js) para junto com a câmera
}
// interruptores da câmera na visão 2D e na cabine 3D ficam sempre sincronizados
function setSwitches(on) { $('cameraBtn').checked = on; }
function camError(msg) {
  $('camWarning').textContent = msg; $('camWarning').hidden = false;
  V.log('Webcam: ' + msg, 'error');
}

// Métricas simuladas por nível (alvo para onde os valores convergem suavemente).
const TARGET = {
  normal: { eyes: 1, pitch: 0, yawn: 0, perclos: 5, fatigue: 10 },
  attention: { eyes: .72, pitch: 9, yawn: .75, perclos: 22, fatigue: 48 },
  critical: { eyes: .38, pitch: 18, yawn: .6, perclos: 46, fatigue: 74 },
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
  eyesBase = lerp(eyesBase, T.eyes, k);
  m.eyesOpen = eyesBase * (1 - blink * .95);
  m.headPitch = lerp(m.headPitch, T.pitch + Math.sin(t / 900) * (T.pitch ? 3 : .8), k);
  m.headYaw = Math.sin(t / 2300) * 4;
  const yawnWave = T.yawn ? Math.max(0, Math.sin(t / 1400)) ** 2 * T.yawn : 0;
  m.mouth = lerp(m.mouth, .04 + yawnWave, k * 2);
  m.perclos = lerp(m.perclos, T.perclos, k * .5);
  m.fatigue = lerp(m.fatigue, T.fatigue, k * .5);
  m.confidence = .95 + Math.sin(t / 700) * .02;
  m.face = { x: .33 + Math.sin(t / 1900) * .015, y: .18 + m.headPitch / 300, w: .34, h: .52 };
}

/* ---------- desenho ---------- */
// Resolução fixa 4:3: a sobreposição é desenhada mesmo com o cartão oculto,
// porque o cartão da cabine 3D copia esta imagem.
function resize() {
  // coordenadas sempre 320×240; a resolução acompanha o tamanho exibido (cartão ampliado fica nítido)
  W = 320; H = 240; dpr = Math.max(2, Math.ceil((canvas.clientWidth || W) * (window.devicePixelRatio || 1) / W));
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
}

/* ---------- câmera ampliada ----------
 * Clicar na imagem leva o cartão da câmera, com todas as opções, do canto para o centro da tela;
 * o resto da página fica desfocado e continua rodando. A animação parte da posição atual (FLIP). */
let backdrop = null, placeholder = null;
// Largura do cartão ampliado para caber inteiro na janela, sem rolagem: a imagem é 4:3,
// então a altura livre (janela menos cabeçalho, botões e métricas) define a largura.
function fitExpanded() {
  const card = $('monitorCard'), body = card.querySelector('.ov-cam-body');
  const cs = getComputedStyle(card), padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const maxW = Math.min(780, innerWidth * .94), maxH = innerHeight * .94;
  let w = maxW;
  for (let i = 0; i < 3; i++) { // o texto pode quebrar linha conforme a largura: refaz a conta
    card.style.width = w + 'px';
    const other = card.offsetHeight - body.offsetHeight;
    w = Math.max(240, Math.min(maxW, (maxH - other) * 4 / 3 + padX));
  }
  card.style.width = w + 'px';
}
function flip(card, from) {
  const to = card.getBoundingClientRect(), k = from.width / to.width;
  card.animate([
    { transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${k})` },
    { transformOrigin: '0 0', transform: 'none' }
  ], { duration: 520, easing: 'cubic-bezier(.2,.85,.25,1)' });
}
function expandCamera(open) {
  const card = $('monitorCard');
  if (open === card.classList.contains('expanded')) return;
  const from = card.getBoundingClientRect();
  if (open) {
    placeholder = document.createElement('div');
    placeholder.className = 'cam-placeholder'; placeholder.style.height = from.height + 'px';
    card.before(placeholder);
    backdrop = document.createElement('div'); backdrop.className = 'cam-backdrop';
    backdrop.onclick = () => expandCamera(false);
    card.parentNode.closest('.app-grid').append(backdrop); // dentro da área de tela cheia, se ativa
    requestAnimationFrame(() => backdrop?.classList.add('show'));
    card.classList.add('expanded');
    fitExpanded();
    V.log('Câmera ampliada', 'camera');
  } else {
    card.classList.remove('expanded');
    card.style.width = '';
    placeholder?.remove(); placeholder = null;
    const b = backdrop; backdrop = null;
    if (b) { b.classList.remove('show'); setTimeout(() => b.remove(), 400); }
  }
  resize();
  flip(card, from);
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
  const pts = r?.pontos, idx = ia.indices;
  // O vídeo preenche o quadro 4:3 cortando as sobras (object-fit: cover) e aparece espelhado:
  // os pontos normalizados passam pelo mesmo corte, senão a malha sai do rosto em vídeos 16:9.
  const v = $('cameraFeed'), vw = v.videoWidth || W, vh = v.videoHeight || H, s = Math.max(W / vw, H / vh);
  const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  const P = i => [W - (ox + pts[i][0] * vw * s), oy + pts[i][1] * vh * s];
  if (!pts) {
    c.fillStyle = 'rgba(3,10,20,.7)'; c.fillRect(W / 2 - 80, H / 2 - 12, 160, 24);
    c.fillStyle = '#ffc44d'; c.font = '800 11px Inter, system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText(ia.carregando ? 'CARREGANDO MODELO…' : 'ROSTO NÃO DETECTADO', W / 2, H / 2 + 4);
    return;
  }
  // Quadrado do rosto: fica também no modo invisível; nele só somem a malha, as setas e os indicadores.
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const i of idx.contorno_rosto) { const [x, y] = P(i); x0 = Math.min(x0, x / W); y0 = Math.min(y0, y / H); x1 = Math.max(x1, x / W); y1 = Math.max(y1, y / H); }
  c.strokeStyle = color; c.lineWidth = 2; corner(c, x0 * W - 6, y0 * H - 6, (x1 - x0) * W + 12, (y1 - y0) * H + 12, 12);
  c.font = '700 10px Inter, system-ui, sans-serif'; c.fillStyle = color; c.textAlign = 'left';
  c.fillText(`ROSTO · CONF. ${Math.round(r.registro.confianca * 100)}%`, x0 * W - 6, y0 * H - 11);
  if (!ia.visivel) return;
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
  // Setas como na janela da análise (entrada/rosto.py): olhar saindo de cada íris e direção da
  // cabeça saindo da ponta do nariz. Calculadas sobre os pontos já espelhados da tela.
  const geo = ia.geo, tela = pts.map((_, i) => P(i));
  const [dx, dy] = geo.olharDaIris(tela, idx);
  for (const { eixo, meia, iris } of geo.olhos(tela, idx)) {
    const k = meia * 3, sx = (dx * eixo[0] - dy * eixo[1]) * k, sy = (dx * eixo[1] + dy * eixo[0]) * k;
    arrow(c, iris[0][0], iris[0][1], iris[0][0] + sx, iris[0][1] + sy, '#ff78ff', 1.3);
  }
  if (r.matriz) {
    const d = geo.direcaoDaCabeca(r.matriz), [a, b] = idx.referencia_escala, [ax, ay] = P(a), [bx, by] = P(b);
    const comp = 1.5 * Math.hypot(ax - bx, ay - by), [x0, y0] = P(idx.ponta_nariz);
    arrow(c, x0, y0, x0 - d[0] * comp, y0 - d[1] * comp, '#ffdc00', 2); // x invertido: a tela é espelhada
  }
  perclosTag(c, x1 * W + 14, y0 * H - 6, r.estimativa?.perclos, color);
  if (r.rosto?.bocejando) yawnTag(c, (x0 + x1) / 2 * W, y1 * H + 10);
  facePanel(c, r);
  const est = r.estado || 'DEGRADADO';
  const lab = { NORMAL: 'MOTORISTA ATENTO', ATENCAO: 'SINAIS DE FADIGA', ALERTA: 'ALERTA DE SONOLÊNCIA', INTERVENCAO: 'INTERVENÇÃO', DEGRADADO: 'COLETANDO EVIDÊNCIA…' }[est];
  c.font = '800 10px Inter, system-ui, sans-serif';
  const tw = c.measureText(lab).width + 16;
  c.fillStyle = 'rgba(3,10,20,.75)'; c.beginPath(); c.roundRect ? c.roundRect(W / 2 - tw / 2, H - 26, tw, 19, 9) : c.rect(W / 2 - tw / 2, H - 26, tw, 19); c.fill();
  c.fillStyle = color; c.textAlign = 'center'; c.fillText(lab, W / 2, H - 13);
}
// Painel no canto, como o da janela da análise: cabeça, olhar, olhos, boca e o modelo CNN.
function facePanel(c, r) {
  const cnn = V.cnn?.media() ?? null;
  const pct = v => Math.round(v * 100) + '%';
  const linhas = [
    ['CNN', cnn ? `${cnn.classe} ${pct(cnn.probabilidades[cnn.classe])}` : V.cnn?.estado === 'pronto' ? (!V.cnn.fresco() ? '…' : V.cnn.base ? 'não confiável' : 'calibrando') : '—'],
    ['cabeça', r.rosto?.cabeca ?? '—'], ['olhar', r.olhar ?? '—'],
    ['olhos', r.rosto?.olhos ?? '—'], ['boca', r.rosto?.boca ?? '—'],
  ];
  const ev = r.evento && V.ia.ultimo.registro.t_ms - r.evento.t < 3000 ? r.evento.texto : null;
  c.font = '700 8.5px Inter, system-ui, sans-serif';
  const h = 12 * linhas.length + 8;
  c.fillStyle = 'rgba(3,10,20,.62)'; c.beginPath(); c.roundRect ? c.roundRect(6, 6, 104, h, 6) : c.rect(6, 6, 104, h); c.fill();
  linhas.forEach(([k, v], n) => {
    c.fillStyle = '#8fb1d4'; c.textAlign = 'left'; c.fillText(k, 12, 18 + n * 12);
    c.fillStyle = n === 0 && cnn ? (cnn.classe === 'alerta' ? '#38f0b0' : '#ff9b91') : '#e8f2ff'; c.fillText(v, 48, 18 + n * 12);
  });
  if (ev) {
    c.font = '800 9px Inter, system-ui, sans-serif';
    const tw = c.measureText(ev).width + 14;
    c.fillStyle = 'rgba(60,40,8,.85)'; c.beginPath(); c.roundRect ? c.roundRect(W / 2 - tw / 2, H - 50, tw, 17, 8) : c.rect(W / 2 - tw / 2, H - 50, tw, 17); c.fill();
    c.fillStyle = '#ffd58a'; c.textAlign = 'center'; c.fillText(ev, W / 2, H - 38.5); c.textAlign = 'left';
  }
}
// Anel com o PERCLOS (fração do tempo com olhos fechados na janela); null = sem evidência.
function perclosTag(c, x, y, v, color) {
  const R = 17;
  x = Math.min(x, W - R * 2 - 6); y = clamp(y, 6, H - R * 2 - 40);
  const cx = x + R, cy = y + R;
  const tone = v == null ? '#7f9cbf' : v > .4 ? '#ff5a4f' : v > .15 ? '#ffc44d' : color;
  c.fillStyle = 'rgba(3,10,20,.72)'; c.beginPath(); c.arc(cx, cy, R + 3, 0, 7); c.fill();
  c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.14)'; c.beginPath(); c.arc(cx, cy, R - 2, 0, 7); c.stroke();
  if (v != null) { c.strokeStyle = tone; c.beginPath(); c.arc(cx, cy, R - 2, -Math.PI / 2, -Math.PI / 2 + clamp(v, 0, 1) * Math.PI * 2); c.stroke(); }
  c.textAlign = 'center'; c.fillStyle = tone;
  c.font = '800 10px Inter, system-ui, sans-serif'; c.fillText(v == null ? '—' : Math.round(v * 100) + '%', cx, cy + 3.5);
  c.font = '800 8px Inter, system-ui, sans-serif'; c.fillText('PERCLOS', cx, cy + R + 13);
  c.textAlign = 'left';
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
  mouthBar(reg?.abertura_boca, !!r?.rosto?.bocejando, V.ia.limiares.abertura_boca_aberta);
  const ix = est?.indice;
  setBar('mFatigue', ix ?? 0, f(ix), ix == null ? 'warn' : ix > 65 ? 'bad' : ix > 35 ? 'warn' : 'ok');
  $('monitorSource').textContent = 'IA REAL · MEDIAPIPE' + (r?.fonte === 'cnn' ? ' + CNN' : '') + (V.ia.visivel ? '' : ' · OCULTO');
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
  // boca (abre com a abertura medida) e PERCLOS ao lado do rosto
  const my = fy + fh * .78 + m.headPitch * .3, mw = fw * .22, mh = Math.max(3, m.mouth * mw);
  c.strokeStyle = color; c.lineWidth = 1.4; c.beginPath(); c.ellipse(fx + fw / 2, my, mw / 2, mh / 2, 0, 0, 7); c.stroke();
  perclosTag(c, fx + fw + 8, fy, m.perclos / 100, color);
  const yawnSim = bocejo(m.mouth);
  mouthBar(m.mouth, yawnSim);
  if (yawnSim) yawnTag(c, fx + fw / 2, fy + fh + 8);
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
  $('cameraBtn').onchange = e => e.target.checked ? startCamera() : stopCamera();
  const body = document.querySelector('#monitorCard .ov-cam-body');
  body.onclick = () => expandCamera(true);
  body.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandCamera(true); } };
  $('camCloseBtn').onclick = () => expandCamera(false);
  addEventListener('keydown', e => { if (e.key === 'Escape') expandCamera(false); });
  addEventListener('resize', () => { if ($('monitorCard').classList.contains('expanded')) { fitExpanded(); resize(); } });
  document.addEventListener('fullscreenchange', () => { if ($('monitorCard').classList.contains('expanded')) { fitExpanded(); resize(); } });
  // Filtro infravermelho: só muda a imagem exibida (o MediaPipe lê o vídeo original).
  $('irBtn').onchange = e => setIR(e.target.checked);
});
V.addRenderer(draw);
})();
