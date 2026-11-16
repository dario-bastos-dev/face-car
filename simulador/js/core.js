/* VIGIA v0.6 — núcleo da simulação.
 * Estado do veículo, mundo (distância, tráfego), ciclo dia/noite, níveis de alerta
 * e registro de eventos. O canal de sinal (IA, WebSocket, replay) fica em sinal.js.
 * Nenhuma função comanda veículo real. */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const now = () => Date.now();

const LEVELS = ['normal', 'attention', 'critical', 'intervention'];
const LABEL = { normal: 'NORMAL', attention: 'ATENÇÃO', critical: 'CRÍTICO', intervention: 'INTERVENÇÃO', degraded: 'DEGRADADO' };

const VEHICLES = {
  car: { name: 'CARRO FAMILIAR', maxSpeed: 210, cruise: 90, decel: 2.2, accel: 2.4 },
  truck: { name: 'CAMINHÃO', maxSpeed: 120, cruise: 75, decel: 1.3, accel: 1.1 }
};

// Geometria da via (metros). Quatro faixas: duas no nosso sentido (a da direita, x>0, onde o
// veículo próprio anda, e a da esquerda, x<0, para ultrapassar) e, separadas delas por uma faixa
// dupla amarela (x = -3,6), duas de contramão à esquerda (contramao: a interna, junto à dupla
// amarela, é a de ultrapassagem de quem vem; a externa, a da direita deles). Linha branca
// tracejada entre as duas de cada sentido. Acostamento dos dois lados. esq: quanto o lado esquerdo
// (acostamento, calçada, cenário) fica além do lado direito por causa da contramão; o direito vai
// até 3,6 m da linha do meio, o esquerdo até -10,8 m.
const ROAD = { laneWidth: 3.6, shoulder: 2.6, egoLaneX: 1.8, leftLaneX: -1.8, contramao: [-5.4, -9.0], esq: 7.2, railOffset: 6.5 };

const VIGIA_SIGN_EVERY = 1500;

const state = {
  vehicle: 'car', level: 'normal', degraded: false, source: 'manual',
  speed: 80, target: 80, manualTarget: false, paused: false,
  driver: 'AGUARDANDO', ackDeadline: 0, ackDone: false,
  hazardOn: false, blinkElapsed: 0, alarmElapsed: 0, cruiseT: 0,
  returning: false, leftOn: false, rightOn: false, // setas (voltando à faixa, ou pelo volante)
  // 'padrao': o simulador dirige sozinho; 'volante': o motorista dirige pelo controlador (volante.js)
  controle: 'padrao',
  re: false, // marcha R (ré), só no modo Volante (veja REVERSA)
  viewMode: '2d', reduceMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
  trafficDensity: 2, cycleMinutes: 4, zoneSeconds: 30, volume: .45,
  events: [], eventSeq: 0,
  channel: null, lastSignal: null, degradedReason: '',
  passCount: 0
};

const world = {
  distance: 0,        // metros percorridos
  odometer: 123456.0, // km ilustrativos
  traffic: [],        // veículos nas duas faixas, no mesmo sentido: {id, z, x, lane, kmh, v0, kind, ...}
  contramao: [],      // veículos na faixa de contramão, vindo de frente: {id, z, x, kmh, kind, ...}
  lead: null,         // veículo mais próximo à frente, no caminho do ego (calculado a cada quadro)
  follower: null,     // veículo mais próximo atrás, no caminho do ego
  spawnTimer: 0, nextId: 1, rpm: 0, gear: 'D', gearNum: 1,
  carga: 0,           // 0..1: quanto o motor está sendo exigido (acelerador)
  trocaT: 0,          // s desde a última troca de marcha (bloqueia trocas seguidas)
  colisao: null,      // batida em andamento: { id, fase: 'parando'|'parado'|'retomada', t }
  // acostamento: pull 0 = na faixa, 1 = no acostamento; pullFrac = posição suavizada (0..1);
  // egoOffset (m) e lateralSpeed (m/s) para a cabine 3D; heading (rad) = rumo em relação à via
  pull: 0, pullFrac: 0, egoOffset: 0, lateralSpeed: 0, lateralAccel: 0, heading: 0,
  posRetorno: 0, // s restantes, depois de voltar à faixa, sem nenhum veículo atrás
};

// Ciclo dia/noite contínuo. timeOfDay em horas (0..24).
const env = {
  timeOfDay: 10.5, night: 0, sunElevation: 1, phase: 'DIA', temperature: 28,
  warp: null // {from, to, t, dur} durante a transição manual acelerada
};

/* ---------- eventos internos ---------- */
const listeners = {};
function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
function emit(name, data) { (listeners[name] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

/* ---------- registro ---------- */
function tsText(ts) { return new Date(ts).toLocaleTimeString('pt-BR', { hour12: false }); }
function log(message, kind = 'info', extra = {}, silent = false) {
  const e = { seq: ++state.eventSeq, ts: now(), event: kind, message, vehicle: state.vehicle, level: state.level, speed_kmh: Number(state.speed.toFixed(1)), ...extra };
  state.events.push(e);
  if (state.events.length > 1000) state.events.shift();
  $('eventCount').textContent = state.events.length + ' eventos';
  if (silent) return;
  const node = document.createElement('div');
  node.className = 'log-item ' + kind;
  const time = document.createElement('time');
  time.textContent = tsText(e.ts);
  const s = document.createElement('span');
  s.textContent = message;
  node.append(time, s);
  $('log').prepend(node);
  while ($('log').children.length > 80) $('log').lastElementChild.remove();
}

/* ---------- cenário: campo ↔ cidade ----------
 * A cada state.zoneSeconds de viagem, agenda a troca de cenário ~600 m à frente,
 * para a cidade (ou o campo) chegar pela estrada. Zonas em metros ao longo da rodovia (S). */
const WORLD_WRAP = 860;                     // padrão de repetição do cenário 3D (m)
const CROSSINGS = [120, 335, 550, 765];     // cruzamentos urbanos: posições S mod WORLD_WRAP
const CITY_NAMES = ['MATIPÓ', 'MANHUAÇU']; // Matipó é a primeira cidade da viagem
const ZONE_BLEND = 90;                      // faixa de transição entre cenários (m)
world.zones = [{ type: 'field', start: -1e9 }];
world.inCity = false;
let zoneClock = 0, cityCount = 0;
function zoneIndexAt(S) { const z = world.zones; let i = 0; for (let k = 1; k < z.length; k++) if (z[k].start <= S) i = k; return i; }
// 0 = campo, 1 = cidade (com transição suave nas bordas)
function cityAmount(S) {
  const z = world.zones, i = zoneIndexAt(S), v = z[i].type === 'city' ? 1 : 0;
  if (i === 0) return v;
  const d = S - z[i].start;
  return d >= ZONE_BLEND ? v : lerp(1 - v, v, smooth(clamp(d / ZONE_BLEND, 0, 1)));
}
function zoneAt(S) { return world.zones[zoneIndexAt(S)]; }
// trechos de cidade dentro de [from, to): [[início, fim, nome]]
function cityRanges(from, to) {
  const z = world.zones, out = [];
  for (let i = 0; i < z.length; i++) {
    if (z[i].type !== 'city') continue;
    const a = Math.max(from, z[i].start), b = Math.min(to, i + 1 < z.length ? z[i + 1].start : Infinity);
    if (b > a) out.push([a, b, z[i].name]);
  }
  return out;
}
function crossingsBetween(from, to) {
  const out = [];
  for (let c = Math.floor(from / WORLD_WRAP); c <= Math.floor(to / WORLD_WRAP); c++)
    for (const o of CROSSINGS) { const S = c * WORLD_WRAP + o; if (S >= from && S < to && cityAmount(S) > .95) out.push(S); }
  return out;
}
function nearCrossing(S, m) { const r = ((S % WORLD_WRAP) + WORLD_WRAP) % WORLD_WRAP; return CROSSINGS.some(o => Math.abs(r - o) < m); }
/* Cartões-postais de Matipó: ao entrar na cidade, três lugares conhecidos aparecem pela via, nesta
 * ordem: a Igreja Matriz (à direita), a Praça do Café (à esquerda) e o centro acadêmico da
 * Univertix (à direita). Cada um ocupa um quarteirão inteiro (POSTAL_MEIO para cada lado), no meio
 * entre dois cruzamentos; ali o 3D e a 2D não põem as casas e prédios genéricos daquele lado.
 * world.postais: [{ tipo, nome, lado, S }]. A cidade dura pelo menos até passar o último. */
const POSTAIS = [
  { tipo: 'igreja', nome: 'Igreja Matriz de Matipó', lado: 1 },
  { tipo: 'praca', nome: 'Praça do Café', lado: -1 },
  { tipo: 'univertix', nome: 'Centro acadêmico da Univertix', lado: 1 },
];
const POSTAL_MEIO = 75, POSTAL_ENTRADA = 140; // m; o primeiro fica a pelo menos 140 m da entrada
world.postais = [];
function marcarPostais(z) {
  const meios = CROSSINGS.map((o, i) => (o + (CROSSINGS[i + 1] ?? CROSSINGS[0] + WORLD_WRAP)) / 2); // entre cruzamentos
  let S = z.start + POSTAL_ENTRADA, k = Math.floor(S / WORLD_WRAP) - 1;
  const lugares = [];
  while (lugares.length < POSTAIS.length) {
    for (const m of meios) { const c = k * WORLD_WRAP + m; if (c >= S && lugares.length < POSTAIS.length && !lugares.includes(c)) lugares.push(c); }
    k++;
  }
  lugares.sort((a, b) => a - b);
  POSTAIS.forEach((P, i) => world.postais.push({ ...P, S: lugares[i], visto: false }));
  z.minFim = lugares.at(-1) + POSTAL_MEIO + 60;
  world.postais = world.postais.filter(p => p.S > world.distance - 1500);
}
// Lote reservado a um cartão-postal na posição S (m) do lado `lado`, se houver.
function postalEm(S, lado) { return world.postais.find(p => p.lado === lado && Math.abs(S - p.S) < POSTAL_MEIO); }
function scheduleZoneSwitch(ahead = 600) {
  const last = world.zones[world.zones.length - 1];
  const type = last.type === 'city' ? 'field' : 'city';
  // Matipó: não termina antes de passar pelos cartões-postais
  if (type === 'field' && last.minFim && world.distance + ahead < last.minFim) return;
  const z = { type, start: Math.max(world.distance + ahead, last.start + 400) };
  if (type === 'city') z.name = CITY_NAMES[cityCount++ % CITY_NAMES.length];
  if (z.name === 'MATIPÓ') marcarPostais(z);
  world.zones.push(z); zoneClock = 0;
  log(type === 'city' ? `Aproximando-se de ${z.name}: perímetro urbano a ${Math.round(z.start - world.distance)} m` : 'Fim do perímetro urbano à frente', 'environment');
  emit('zone', z);
}
function updateZones(dt) {
  if (state.speed > 1) zoneClock += dt; // conta só o tempo em movimento
  // registro ao passar por um cartão-postal
  for (const p of world.postais) if (!p.visto && Math.abs(p.S - world.distance) < 40) { p.visto = true; log(`Matipó: ${p.nome} à ${p.lado > 0 ? 'direita' : 'esquerda'}`, 'environment'); }
  if (zoneClock >= state.zoneSeconds) scheduleZoneSwitch();
  const z = world.zones; // descarta zonas que já ficaram bem para trás
  while (z.length > 2 && z[1].start < world.distance - 2500) { z.shift(); z[0].start = -1e9; }
  const inCity = cityAmount(world.distance) > .5;
  if (inCity !== world.inCity) { world.inCity = inCity; const zz = zoneAt(world.distance); log(inCity ? `Perímetro urbano: ${zz.name}` : 'Rodovia: saída do perímetro urbano', 'environment'); emit('inCity', inCity); }
}

// Pedestres nas calçadas (só existem dentro da cidade). x = lateral (7,4..9,8 m à direita; à esquerda, mais ROAD.esq).
world.peds = [];
const SHIRTS = ['#d23a33', '#2d5fa8', '#f2f2ef', '#2c6b4f', '#e0a526', '#6b3fa0', '#17191c', '#d86aa0', '#3aa0c8'];
const PANTS = ['#2b3442', '#1d1f22', '#5b4a3a', '#3c4f63', '#8a7d6b', '#14213d'];
const SKIN = ['#f1c9a5', '#d9a77e', '#b07a52', '#8a5a3c', '#5e3b26'];
function initPeds() {
  for (let i = 0; i < 34; i++) world.peds.push({ id: i, active: false, S: 0, x: 0, dir: 1, speed: 1.1 + Math.random() * .6, phase: Math.random() * 6, shirt: pick(SHIRTS), pants: pick(PANTS), skin: pick(SKIN) });
}
function updatePeds(dt) {
  const d = world.distance;
  for (const p of world.peds) {
    if (p.active) {
      p.S += p.dir * p.speed * dt; p.phase += dt * p.speed * 4.4;
      if (p.S - d < -140 || p.S - d > 480 || cityAmount(p.S) < .9) p.active = false;
    } else if (Math.random() < dt * 3) {
      const S = d - 60 + Math.random() * 520;
      if (cityAmount(S) > .97 && !nearCrossing(S, 7)) {
        const side = Math.random() < .5 ? -1 : 1;
        // calçada esquerda: além da contramão (ROAD.esq)
        Object.assign(p, { active: true, S, x: side * (7.4 + Math.random() * 2.3 + (side < 0 ? ROAD.esq : 0)), dir: Math.random() < .5 ? 1 : -1 });
      }
    }
  }
}

/* ---------- placas (sem limites de velocidade nesta versão) ---------- */
// Placas no trecho [from, to): {type, at, value}
// Sinalização que se repete a cada ROUTE_CYCLE metros (posição dentro do ciclo, tipo).
const ROUTE_CYCLE = 2400;
const ROUTE_SIGNS = [
  { at: 250, type: 'city' },       // placa verde de direção com distâncias
  { at: 620, type: 'animals' },    // advertência: animais na pista
  { at: 1450, type: 'rest' },      // educativa: cansado? pare e descanse
  { at: 1800, type: 'belt' },      // educativa: use o cinto
  { at: 2120, type: 'distance' }   // educativa: mantenha distância
];
const CITIES = [['MATIPÓ', 18], ['MANHUAÇU', 58], ['BELO HORIZONTE', 286]];
function signsBetween(from, to) {
  const out = [];
  for (let c = Math.floor(from / ROUTE_CYCLE); c <= Math.floor(to / ROUTE_CYCLE); c++) {
    for (const r of ROUTE_SIGNS) {
      const at = c * ROUTE_CYCLE + r.at;
      if (at < from || at >= to) continue;
      // distâncias das cidades diminuem a cada placa (até "chegar" e recomeçar)
      const value = r.type === 'city' ? CITIES.map(([n, km]) => [n, Math.max(3, km - (c % 10) * 1.5).toFixed(0)]) : undefined;
      if (cityAmount(at) < .5) out.push({ type: r.type, at, value }); // sinalização de rodovia só no campo
    }
  }
  for (const z of world.zones) if (z.type === 'city' && z.start + 30 >= from && z.start + 30 < to) out.push({ type: 'welcome', at: z.start + 30, value: z.name });
  for (const S of crossingsBetween(from - 50, to + 50)) {
    if (S - 45 >= from && S - 45 < to) out.push({ type: 'pedestrian', at: S - 45 });
    if (S + 35 >= from && S + 35 < to) out.push({ type: 'busStop', at: S + 35 });
  }
  for (let s = Math.ceil(from / VIGIA_SIGN_EVERY) * VIGIA_SIGN_EVERY + 700; s < to; s += VIGIA_SIGN_EVERY) out.push({ type: 'vigia', at: s });
  for (let s = Math.ceil(from / 1000) * 1000 + 300; s < to; s += 1000) out.push({ type: 'km', at: s, value: 312 + Math.floor(s / 1000) });
  return out;
}

// Velocidade de cruzeiro padrão de cada veículo.
function cruiseFor() { return VEHICLES[state.vehicle].cruise; }

/* ---------- tráfego (metros, relativo ao ego) ---------- */
// Tipos de veículo do tráfego: dimensões (m), frequência e cores.
// 'truck' = carreta; 'toco' = caminhão toco; 'truck34' = caminhão 3/4; 'gol' = Gol "bolinha".
const BOX_COLORS = ['#f2f2ef', '#e8e9ea', '#c9312c', '#2d5fa8', '#f3f3f1', '#d8b13a', '#3f7d4e'];
const CAB_COLORS = ['#f4f4f2', '#d23a33', '#24508f', '#f4f4f2', '#2f3a44', '#e3e4e6'];
const VEHICLE_TYPES = {
  truck:   { len: 16.5, width: 2.55, weight: 13, heavy: true, colors: BOX_COLORS },
  toco:    { len: 9.2,  width: 2.5,  weight: 10, heavy: true, colors: BOX_COLORS },
  truck34: { len: 6.9,  width: 2.2,  weight: 10, heavy: true, colors: BOX_COLORS },
  van:     { len: 5.9,  width: 2.0,  weight: 10, colors: ['#f4f4f2', '#e9eaec', '#c2c6cb', '#f4f4f2'] },
  pickup:  { len: 5.3,  width: 1.9,  weight: 15, colors: ['#e9eaec', '#b7bec7', '#1f2a36', '#8c1d22', '#3c4f63', '#7a1418'] },
  gol:     { len: 3.9,  width: 1.64, weight: 20, colors: ['#f4f4f2', '#b3131b', '#c2c6cb', '#1b2f5e', '#17191c', '#2d5a3a', '#d6c48a'] },
  car:     { len: 4.5,  width: 1.85, weight: 22, colors: ['#b7bec7', '#1f2a36', '#8c1d22', '#e9eaec', '#3c4f63', '#56606b', '#2c6b4f'] }
};
const TYPE_BAG = Object.entries(VEHICLE_TYPES).flatMap(([k, v]) => Array(v.weight).fill(k));
function vehicleLength(kind) { return (VEHICLE_TYPES[kind] || VEHICLE_TYPES.car).len; }
function isHeavy(kind) { return !!VEHICLE_TYPES[kind]?.heavy; }
// Sorteia modelo e cores de um veículo (opcionalmente restrito a alguns tipos).
function randomVehicle(only) {
  const kind = only ? pick(only) : pick(TYPE_BAG), t = VEHICLE_TYPES[kind];
  return { kind, len: t.len, color: pick(t.colors), cab: pick(CAB_COLORS) };
}
// Todas as visões usam o tamanho real dos veículos (a 2D é desenhada na mesma escala nas duas
// direções). Antes a 2D ampliava os veículos 2,1x e as batidas usavam caixas diferentes em cada
// visão: com a 2D à vista (inclusive a tela simplificada da cabine), um veículo aparecia dentro do outro.
const DISPLAY_SCALE = 1;
const half = len => len * DISPLAY_SCALE / 2;
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* Tráfego em mão única: duas faixas no mesmo sentido.
 * Cada veículo tem a velocidade que deseja (v0): caminhões devagar, carros mais rápidos, alguns
 * apressados. Na faixa, segue o da frente (modelo IDM, que inclui o ego como obstáculo). Preso
 * atrás de alguém mais lento, passa para a esquerda se houver espaço e volta para a direita assim
 * que pode. Os mais lentos que o ego surgem à frente; os mais rápidos, atrás (vistos pelos
 * retrovisores). Entre si nunca batem; com o ego, uma batida (colisão) é possível no modo Volante. */
// 0 = faixa da direita, 1 = faixa da esquerda, 2 = acostamento (só quem encosta para dar passagem)
const LANE_X = [ROAD.egoLaneX, ROAD.leftLaneX, ROAD.laneWidth + ROAD.shoulder / 2];
const DENSIDADE = [0, 5, 8, 12];                  // veículos em cena por nível de tráfego
const egoX = () => ROAD.egoLaneX + world.egoOffset;
const largura = kind => (VEHICLE_TYPES[kind] || VEHICLE_TYPES.car).width;
const egoLargura = () => largura(state.vehicle === 'truck' ? 'truck' : 'car');
// sobreposição lateral entre dois veículos (centros x, larguras w), com folga m (metros)
const ladoALado = (xa, wa, xb, wb, m = 0) => Math.abs(xa - xb) < (wa + wb) / 2 + m;
// ocupa (mesmo que em parte) a faixa `lane`
const naFaixa = (x, w, lane) => Math.abs(x - LANE_X[lane]) < w / 2 + ROAD.laneWidth / 2 - .25;

function velDesejada(kind) {
  if (isHeavy(kind)) return 62 + Math.random() * 24;
  if (Math.random() < .18) return 135 + Math.random() * 35; // apressados
  return 85 + Math.random() * 45;
}
function novoVeiculo(z, lane, v0, kmh, v = randomVehicle()) {
  const T = { id: world.nextId++, z, lane, x: LANE_X[lane], latV: 0, heading: 0, seta: 0, decT: Math.random(),
    ...v, width: largura(v.kind), v0: v0 ?? velDesejada(v.kind), braking: false, crash: false, lado: Math.sign(z) || 1 };
  T.kmh = kmh ?? T.v0;
  world.traffic.push(T);
  return T;
}
// lugar livre para surgir: ninguém na mesma faixa a menos de `m` metros
function vagaLivre(z, lane, len, m = 45) {
  return world.traffic.every(t => t.lane !== lane && !naFaixa(t.x, t.width, lane) || Math.abs(t.z - z) > half(len) + half(t.len) + m);
}
// Largada: pista vazia nos primeiros LARGADA_VAZIA s; depois o tráfego chega aos poucos (surgir).
const LARGADA_VAZIA = 1;
function seedTraffic() {
  world.traffic = []; world.contramao = []; world.colisao = null;
  if ((world.largadaT ?? 99) < LARGADA_VAZIA) { atualizarVizinhos(); return; }
  const n = DENSIDADE[state.trafficDensity] || 0, ext = egoExtent();
  for (let i = 0; i < n; i++) {
    const v = randomVehicle(), z = -240 + (i + Math.random() * .6) * 640 / Math.max(1, n);
    let lane = isHeavy(v.kind) || Math.random() < .6 ? 0 : 1;
    if (lane === 0 && z > -ext.rear - 30 && z < ext.front + 40) lane = 1; // longe do ego na faixa dele
    if (z > -ext.rear - 15 && z < LARGADA_LOGO + 45) continue;           // largada livre: o logo pintado à vista
    let v0 = velDesejada(v.kind);
    // no Padrão o ego não ultrapassa: quem está à frente na faixa dele é mais rápido que ele
    if (state.controle === 'padrao' && lane === 0 && z > 0) v0 = Math.max(v0, cruiseFor() + 12);
    if (vagaLivre(z, lane, v.len, 20)) novoVeiculo(z, lane, v0, undefined, v);
  }
  atualizarVizinhos();
}
function surgir() {
  if ((world.largadaT ?? 99) < LARGADA_VAZIA) return;
  if (world.traffic.length >= (DENSIDADE[state.trafficDensity] || 0)) return;
  const v = randomVehicle(), v0 = velDesejada(v.kind), ego = state.speed;
  const voltando = state.controle === 'padrao' && (world.pull > 0 || world.posRetorno > 0);
  if (v0 > ego + 6) {
    // mais rápido: chega por trás, ao fundo do retrovisor
    const lane = voltando ? 1 : isHeavy(v.kind) ? 0 : Math.random() < .5 ? 0 : 1, z = -300 - Math.random() * 25;
    if (vagaLivre(z, lane, v.len)) novoVeiculo(z, lane, v0, Math.min(v0, ego + 40), v);
  } else if (v0 < ego - 6 && state.controle === 'volante') {
    // mais lento: aparece lá na frente, na faixa da direita (no Padrão não surge ninguém para frear o ego)
    const z = 460 + Math.random() * 40;
    if (vagaLivre(z, 0, v.len)) novoVeiculo(z, 0, v0, v0, v);
  }
}
// O que está no caminho de T, à frente: veículo (ou o ego) e o espaço livre até ele (para-choque a
// para-choque, nos comprimentos ampliados da 2D, para nenhuma visão mostrar sobreposição).
function liderDe(T) {
  let lider = null, gap = Infinity;
  const frente = T.z + half(T.len), alvoX = LANE_X[T.lane];
  const noCaminho = (x, w) => ladoALado(T.x, T.width, x, w, .3) || ladoALado(alvoX, T.width, x, w, .3);
  for (const O of world.traffic) {
    if (O === T || O.z <= T.z || !noCaminho(O.x, O.width)) continue;
    const g = O.z - half(O.len) - frente;
    if (g < gap) { gap = g; lider = O; }
  }
  const ext = egoExtent();
  // Intervenção: o ego reduz devagar e atravessa até o acostamento da direita. Quem vem atrás numa
  // faixa que ele vai cruzar (à direita da borda esquerda dele) também o trata como obstáculo e
  // freia atrás dele, em vez de seguir e bater de lado.
  const cruzando = intervencao() && T.lane !== 2 && T.x + T.width / 2 > egoX() - egoLargura() / 2;
  if (T.z < ext.center && (noCaminho(egoX(), egoLargura()) || cruzando)) {
    const g = -ext.rear - frente;
    if (g < gap) { gap = g; lider = EGO; }
  }
  return { lider, gap };
}
const EGO = { ego: true, get kmh() { return velEgo(); } };
// Velocidade do ego com o sentido (km/h): negativa na ré. state.speed é sempre o módulo (painel, som).
const velEgo = () => state.re ? -state.speed : state.speed;
// Faixa `lane` livre para T entrar: espaço à frente e atrás, contando a diferença de velocidade.
function faixaLivre(T, lane) {
  const frente = T.z + half(T.len), tras = T.z - half(T.len), ext = egoExtent();
  const obst = world.traffic.filter(O => O !== T && naFaixa(O.x, O.width, lane))
    .map(O => ({ zf: O.z + half(O.len), zr: O.z - half(O.len), kmh: O.kmh }));
  if (naFaixa(egoX(), egoLargura(), lane)) obst.push({ zf: ext.front, zr: -ext.rear, kmh: state.speed });
  for (const O of obst) {
    if (O.zr >= frente) { if (O.zr - frente < 18 + Math.max(0, T.kmh - O.kmh) / 3.6 * 2.2) return false; }
    else if (O.zf <= tras) { if (tras - O.zf < 10 + Math.max(0, O.kmh - T.kmh) / 3.6 * 2.6) return false; }
    else return false; // lado a lado
  }
  return true;
}
function decidirFaixa(T, lider, gap, dt) {
  if (T.encostar) { darPassagem(T, dt); return; }
  const trocando = Math.abs(T.x - LANE_X[T.lane]) > .1;
  if (trocando) {
    // no meio da troca, a faixa de destino deixou de estar livre: desiste e volta
    if (!faixaLivreAgora(T, T.lane)) { T.lane = 1 - T.lane; T.seta = T.lane === 1 ? -1 : 1; }
    return;
  }
  T.seta = 0;
  if ((T.decT -= dt) > 0) return;
  T.decT = .3 + Math.random() * .5;
  const voltando = state.controle === 'padrao' && (world.pull > 0 || world.posRetorno > 0);
  if (T.lane === 0) {
    // atrás do ego parado: não sai na hora; primeiro espera e buzina (atrasDoEgoParado decide)
    const preso = lider && gap < 30 + T.kmh / 3.6 * 2 && lider.kmh < T.v0 - 6 && !(lider === EGO && state.speed < 3);
    // ego voltando do acostamento: quem vem atrás na faixa da direita passa para a esquerda
    const abrir = voltando && T.z < 0 && T.z > -260;
    if ((preso || abrir) && faixaLivre(T, 1)) { T.lane = 1; T.seta = -1; }
  } else {
    // mantém a direita: volta assim que houver espaço e ninguém mais lento logo à frente
    const dir = liderNaFaixa(T, 0);
    const vale = !dir.lider || dir.gap > 150 || dir.lider.kmh >= T.v0 - 4;
    if (vale && faixaLivre(T, 0) && !(voltando && T.z < 0)) { T.lane = 0; T.seta = 1; }
  }
}
/* Parado atrás do ego parado (na faixa dele): espera ATRAS.espera s, dá duas buzinadas curtas (uma
 * vez só, evento buzinaTrafego) e, se o ego continuar parado por mais ATRAS.buzina s, dá seta e
 * ultrapassa pela outra faixa do mesmo sentido assim que ela estiver livre, saindo devagar de trás
 * dele. Se o ego andar antes, desiste e segue normalmente. */
const ATRAS = { espera: .8, buzina: 5, gap: 20 };
function atrasDoEgoParado(T, lider, gap, dt) {
  const ext = egoExtent();
  if (T.ultrapassandoEgo && T.z - half(T.len) > ext.front + 4) T.ultrapassandoEgo = false; // já passou
  const preso = lider === EGO && state.speed < 3 && T.kmh < 8 && gap < ATRAS.gap && !emColisao() && !state.re;
  if (!preso) { if (state.speed > 5 || lider !== EGO) { T.atrasT = 0; T.buzinouEgo = false; } return; }
  T.atrasT = (T.atrasT || 0) + dt;
  if (T.atrasT > ATRAS.espera && !T.buzinouEgo) { T.buzinouEgo = true; emit('buzinaTrafego', { ...T, toques: 2 }); }
  if (T.atrasT >= ATRAS.espera + ATRAS.buzina && !T.ultrapassandoEgo && Math.abs(T.x - LANE_X[T.lane]) < .1) {
    const outra = T.lane === 0 ? 1 : 0;
    if (faixaLivre(T, outra)) {
      T.lane = outra; T.seta = outra === 1 ? -1 : 1; T.ultrapassandoEgo = true; T.decT = 2;
      log('O veículo de trás desistiu de esperar e vai ultrapassar', 'vehicle');
    }
  }
}
/* Buzina pedindo passagem: o veículo logo à frente, no caminho do ego, dá seta para a direita,
 * espera um instante e encosta devagar no acostamento (passando antes para a faixa da direita, se
 * estiver na da esquerda), reduzindo. Depois que o ego passa (ou após 25 s), dá seta para a
 * esquerda e volta à faixa da direita quando houver espaço, retomando a velocidade dele. */
const PASSAGEM = { alcance: 80, sinal: 1.3, lateral: .65, vEncostando: 45, vEncostado: 25, espera: 25 };
function pedirPassagem() {
  const T = world.lead, ext = egoExtent();
  if (!T || T.crash || T.encostar || T.lane === 2) return;
  if (T.z - half(T.len) - ext.front > PASSAGEM.alcance) return;
  T.encostar = { fase: 'sinal', t: 0, v0: T.v0 };
  T.seta = 1;
  log('Buzina: o veículo à frente vai encostar no acostamento para dar passagem', 'vehicle');
}
function darPassagem(T, dt) {
  const E = T.encostar, ext = egoExtent();
  E.t += dt;
  const chegou = Math.abs(T.x - LANE_X[T.lane]) < .05;
  if (E.fase === 'sinal') {            // seta ligada antes de mexer o volante
    T.seta = 1; T.v0 = Math.min(E.v0, PASSAGEM.vEncostando + 25);
    if (E.t < PASSAGEM.sinal || !chegou) return;
    if (T.lane === 1) { if (faixaLivre(T, 0)) T.lane = 0; return; } // primeiro para a faixa da direita
    if (faixaLivre(T, 2)) { T.lane = 2; E.fase = 'encostando'; E.t = 0; }
  } else if (E.fase === 'encostando') {
    T.seta = 1; T.v0 = PASSAGEM.vEncostando;
    if (chegou) { E.fase = 'encostado'; E.t = 0; T.seta = 0; }
  } else if (E.fase === 'encostado') {
    T.v0 = PASSAGEM.vEncostado;
    const passou = T.z + half(T.len) < -ext.rear - 15;
    if (passou || E.t > PASSAGEM.espera) { E.fase = 'voltar'; E.t = 0; }
  } else if (E.fase === 'voltar') {   // seta para a esquerda e volta quando houver espaço
    T.seta = -1;
    if (E.t > PASSAGEM.sinal && faixaLivre(T, 0)) { T.lane = 0; T.v0 = E.v0; E.fase = 'retornando'; }
  } else if (E.fase === 'retornando') {
    T.seta = -1;
    if (chegou) { T.encostar = null; T.seta = 0; }
  }
}
function faixaLivreAgora(T, lane) {
  const frente = T.z + half(T.len), tras = T.z - half(T.len), ext = egoExtent();
  const perto = (zf, zr) => zr < frente + 3 && zf > tras - 3;
  if (naFaixa(egoX(), egoLargura(), lane) && perto(ext.front, -ext.rear) && !ladoALado(T.x, T.width, egoX(), egoLargura(), .2)) return false;
  return !world.traffic.some(O => O !== T && naFaixa(O.x, O.width, lane) && !ladoALado(T.x, T.width, O.x, O.width) && perto(O.z + half(O.len), O.z - half(O.len)));
}
function liderNaFaixa(T, lane) {
  let lider = null, gap = Infinity;
  const frente = T.z + half(T.len), ext = egoExtent();
  for (const O of world.traffic) {
    if (O === T || O.z <= T.z || !naFaixa(O.x, O.width, lane)) continue;
    const g = O.z - half(O.len) - frente; if (g < gap) { gap = g; lider = O; }
  }
  if (T.z < ext.center && naFaixa(egoX(), egoLargura(), lane)) { const g = -ext.rear - frente; if (g < gap) { gap = g; lider = EGO; } }
  return { lider, gap };
}

function updateTraffic(dt) {
  const ego = velEgo() / 3.6;
  world.largadaT = (world.largadaT ?? 99) + dt;
  world.spawnTimer += dt;
  if (world.spawnTimer >= .6) { world.spawnTimer = 0; surgir(); }
  world.traffic.sort((a, b) => b.z - a.z); // o mais à frente primeiro
  for (const T of world.traffic) {
    const { lider, gap } = liderDe(T);
    const v = T.kmh / 3.6;
    let acc;
    if (T.crash) acc = -11; // bateu: freia até parar e espera (veja atualizarColisao)
    else {
      // atrás do ego em intervenção (freando devagar rumo ao acostamento): distância maior
      const pesado = isHeavy(T.kind), a = pesado ? 1 : 1.8, b = 3, s0 = lider === EGO && intervencao() ? 8 : 4, Th = lider === EGO && intervencao() ? 1.8 : 1.1;
      const v0 = Math.max(T.v0, 1) / 3.6;
      acc = a * (1 - Math.pow(v / v0, 4));
      if (lider) {
        const dv = v - lider.kmh / 3.6;
        const sStar = s0 + Math.max(0, v * Th + v * dv / (2 * Math.sqrt(a * b)));
        acc = a * (1 - Math.pow(v / v0, 4) - Math.pow(sStar / Math.max(gap, .3), 2));
      }
      acc = clamp(acc, -9, a);
      // preso atrás do ego (ou fechado por ele): buzina, no máximo uma vez a cada 8 s (parado atrás
      // do ego parado é outro caso: buzina contínua e depois ultrapassa, em atrasDoEgoParado)
      if (lider === EGO && !T.atrasT && state.speed >= 3 && (acc < -3.5 || (gap < 25 && state.speed < T.v0 - 25)) && (T.buzinaT ?? -99) < motion.t - 8) { T.buzinaT = motion.t; emit('buzinaTrafego', T); }
      atrasDoEgoParado(T, lider, gap, dt);
      decidirFaixa(T, lider, gap, dt);
    }
    T.kmh = Math.max(0, (v + acc * dt) * 3.6);
    T.braking = acc < -1 || (T.crash && T.kmh > .1);
    T.z += (T.kmh / 3.6 - ego) * dt;
    // entre os veículos do tráfego, nunca há sobreposição
    if (lider && lider !== EGO) {
      const minZ = lider.z - half(lider.len) - half(T.len) - 1;
      if (T.z > minZ) { T.z = minZ; T.kmh = Math.min(T.kmh, lider.kmh); }
    }
    // troca de faixa: velocidade lateral suave (cerca de 3 s de uma faixa para a outra)
    const dx = LANE_X[T.lane] - T.x;
    const latMax = T.encostar ? PASSAGEM.lateral : 1.25; // encostando para dar passagem: devagar
    // saindo de trás do ego parado, quase parado: desvia devagar mesmo assim (como quem esterça e sai)
    const alvo = Math.sign(dx) * Math.min(latMax, Math.sqrt(2 * .8 * Math.abs(dx))) * clamp(T.kmh / 20, T.ultrapassandoEgo ? .8 : 0, 1);
    T.latV += clamp(alvo - T.latV, -.9 * dt, .9 * dt);
    T.x += T.latV * dt;
    if (Math.abs(LANE_X[T.lane] - T.x) < .03 && Math.abs(T.latV) < .15) { T.x = LANE_X[T.lane]; T.latV = 0; }
    T.heading = Math.atan2(T.latV, Math.max(T.kmh / 3.6, 2));
    // passagem pelo ego (ultrapassou ou foi ultrapassado)
    const lado = T.z >= 0 ? 1 : -1;
    if (lado !== T.lado) { T.lado = lado; state.passCount++; emit('pass', { ...T, rel: Math.abs(T.kmh - state.speed), ultrapassou: lado > 0 }); }
  }
  world.traffic = world.traffic.filter(t => t.z < 540 && t.z > -360 || world.colisao?.id === t.id);
  updateContramao(dt);
  atualizarVizinhos();
  if (!(state.controle === 'volante' && !intervencao())) semSobreposicao(dt);
  else state.aeb = false;
  detectarColisao();
  atualizarColisao(dt);
  separarDoEgo();
}
/* Contramão: duas faixas à esquerda, no sentido oposto. Os veículos surgem lá na frente e passam
 * pelo ego em velocidade de estrada, em fila em cada faixa (sem trocar de faixa): os pesados e a
 * maioria na externa (a da direita de quem vem), os mais rápidos também na interna. Se o ego invade
 * a faixa deles (modo Volante), só o primeiro que vem de frente nela reage: freia forte e, a
 * CONTRA.alerta m ou menos, pisca o farol sem parar e buzina contínuo (world.contraAlerta, som em
 * audio.js) até o ego sair da frente dele; os de trás só seguem a fila. Se mesmo assim os dois se
 * tocam, é uma colisão frontal (veja detectarColisao). */
const CONTRA = { densidade: [0, 4, 7, 11], surgeZ: 560, frenagem: 7, alcance: 180, alerta: 50 };
function surgirContramao() {
  if ((world.largadaT ?? 99) < LARGADA_VAZIA) return;
  const C = world.contramao;
  if (C.length >= (CONTRA.densidade[state.trafficDensity] || 0)) return;
  const v = randomVehicle(), z = CONTRA.surgeZ + Math.random() * 80;
  const faixa = isHeavy(v.kind) || Math.random() < .6 ? 1 : 0, x = ROAD.contramao[faixa];
  // espaço até quem já está lá na frente, na mesma faixa
  if (C.some(t => t.x === x && Math.abs(t.z - z) < half(v.len) + half(t.len) + 25 + Math.random() * 40)) return;
  const v0 = isHeavy(v.kind) ? 65 + Math.random() * 20 : faixa ? 80 + Math.random() * 25 : 95 + Math.random() * 30;
  C.push({ id: world.nextId++, z, x, ...v, width: largura(v.kind), v0, kmh: v0, braking: false, crash: false, lado: 1, contra: true });
}
function updateContramao(dt) {
  const ego = velEgo() / 3.6, C = world.contramao, ext = egoExtent();
  world.contraTimer = (world.contraTimer || 0) + dt;
  if (world.contraTimer >= .5) { world.contraTimer = 0; surgirContramao(); }
  C.sort((a, b) => a.z - b.z); // quem vai na frente (no sentido deles) primeiro: o de menor z
  // o primeiro que vem de frente na faixa que o ego ocupa (o de menor z à frente dele)
  let primeiro = null;
  for (const T of C) if (T.z > ext.front && ladoALado(egoX(), egoLargura(), T.x, T.width, .2) && (!primeiro || T.z < primeiro.z)) primeiro = T;
  const frenteNa = new Map(); // faixa (x) -> o veículo logo à frente nela
  for (const T of C) {
    const frente = frenteNa.get(T.x) || null;
    let alvo = T.v0, acc, perigo = false;
    // batido de frente com o ego: espera parado até o ego sair da faixa dele; depois segue viagem
    if (T.batido && !T.crash && !ladoALado(egoX(), egoLargura(), T.x, T.width, .3)) { T.batido = false; log('Contramão: veículo batido segue viagem', 'vehicle'); }
    if (T.crash) acc = -11;
    else if (T.batido) { acc = -11; alvo = 0; }
    else {
      // ego na faixa deles, à frente (entre o ego e o alcance): freia forte, buzina e dá farol
      perigo = T === primeiro && T.z - half(T.len) - ext.front < CONTRA.alcance;
      if (perigo) alvo = 0;
      // segue o da frente dele (sem ultrapassar), com folga
      if (frente) {
        const gap = (T.z - half(T.len)) - (frente.z + half(frente.len));
        if (gap < 30) alvo = Math.min(alvo, frente.kmh * clamp(gap / 30, 0, 1));
      }
      acc = alvo < T.kmh - .5 ? -(perigo ? CONTRA.frenagem : 3) : alvo > T.kmh + .5 ? 1.5 : 0;
    }
    // farol piscando e buzina contínua: o primeiro, a CONTRA.alerta m ou menos (também parado, depois de uma batida)
    T.farol = T === primeiro && !T.batido && T.z - half(T.len) - ext.front <= CONTRA.alerta; // depois da batida, não
    const v = Math.max(0, T.kmh / 3.6 + acc * dt);
    T.braking = acc < -1 && v > .1;
    T.kmh = Math.min(T.v0, v * 3.6);
    T.z -= (T.kmh / 3.6 + ego) * dt;
    if (frente) T.z = Math.max(T.z, frente.z + half(frente.len) + half(T.len) + 1); // nunca se sobrepõem
    // passagem pelo ego (cruzou com ele)
    const lado = T.z >= 0 ? 1 : -1;
    if (lado !== T.lado) { T.lado = lado; state.passCount++; emit('pass', { ...T, rel: state.speed + T.kmh, contra: true }); }
    frenteNa.set(T.x, T);
  }
  world.contramao = C.filter(t => t.z > -360 && t.z < 800 || world.colisao?.id === t.id);
  const alerta = world.contramao.find(t => t.farol) || null;
  if ((alerta?.id ?? null) !== (world.contraAlerta?.id ?? null)) {
    if (alerta) log('Contramão: veículo de frente piscando o farol e buzinando', 'vehicle');
    world.contraAlerta = alerta;
  }
}
const intervencao = () => !state.degraded && state.level === 'intervention';
// world.lead / world.follower: os mais próximos à frente e atrás, no caminho do ego
function atualizarVizinhos() {
  const ex = egoX(), ew = egoLargura();
  let lead = null, fol = null;
  for (const T of world.traffic) {
    if (!ladoALado(T.x, T.width, ex, ew, .3)) continue;
    if (T.z > 0 && (!lead || T.z < lead.z)) lead = T;
    if (T.z <= 0 && (!fol || T.z > fol.z)) fol = T;
  }
  world.lead = lead; world.follower = fol;
}
// Ego "na faixa" (ocupa a faixa, mesmo que em parte) enquanto não está todo no acostamento.
const NA_FAIXA = .98;
// Frenagem automática (modo Padrão e intervenção): o veículo à frente no caminho fica sempre a
// pelo menos 4 m; se o ego chega rápido demais, reduz até a velocidade dele (luz de freio acesa).
// No modo Volante quem freia é o motorista: chegar rápido demais é uma batida.
function semSobreposicao(dt) {
  state.aeb = false;
  const T = world.lead;
  if (T && !T.crash) {
    const ext = egoExtent(), minZ = ext.front + half(T.len) + 4, gap = T.z - minZ;
    if (gap < 14 && state.speed > T.kmh + .5) {
      state.speed = Math.max(T.kmh, state.speed - 32 * dt);
      state.aeb = true;
      if (!state.aebAviso) { state.aebAviso = true; log('Frenagem automática: veículo à frente muito perto', 'intervention'); }
    }
    if (T.z < minZ) { T.z = minZ; T.kmh = Math.max(T.kmh, state.speed); }
  }
  if (!state.aeb) state.aebAviso = false;
  else state.freando = true;
}

/* ---------- colisão ----------
 * Caixas dos veículos: na visão 2D, as desenhadas (ampliadas); na 3D, as reais. Assim a batida
 * acontece quando os veículos se tocam na tela que está à vista. Ao bater, os dois param juntos
 * (pisca-alerta ligado), esperam 2 s e só então retomam: o tráfego volta à velocidade dele e o
 * motorista recupera os comandos. */
const COLISAO = { freio: 11 * 3.6, parado: 2, carencia: 2.5 }; // freio em km/h por segundo
// Caixas físicas (as mesmas na 2D e no 3D).
function caixaEgo() {
  const ext = egoFisico();
  return { zf: ext.front, zr: -ext.rear, x: egoX(), hw: egoLargura() / 2 };
}
function caixa(T) {
  const hl = T.len / 2;
  return { zf: T.z + hl, zr: T.z - hl, x: T.x, hw: T.width / 2 };
}
/* Nenhum veículo atravessa o ego, em nenhuma visão e em nenhum momento: também na carência depois
 * de uma batida (quando detectarColisao ignora o mesmo veículo) e com o motorista insistindo no
 * acelerador ou no volante. A cada quadro, quem se sobrepõe ao ego é afastado pelo lado de menor
 * sobreposição, e as velocidades se acertam para não voltar a entrar. */
function separarDoEgo() {
  for (const T of world.traffic.concat(world.contramao)) {
    const E = caixaEgo(), B = caixa(T);
    const sobreZ = Math.min(E.zf, B.zf) - Math.max(E.zr, B.zr), sobreX = E.hw + B.hw - Math.abs(E.x - B.x);
    if (sobreZ <= 0 || sobreX <= 0) continue;
    if (sobreX < sobreZ) {
      // lado a lado: o ego sai para o lado oposto ao do outro veículo
      world.egoOffset += (Math.sign(egoX() - T.x) || 1) * (sobreX + .02);
      world.pull = world.pullFrac = world.egoOffset / PULL_DIST;
      world.lateralSpeed = 0;
    } else if (T.z > 0) {
      // à frente: encosta no para-choque traseiro dele (ou no dianteiro, se vem de frente)
      T.z += E.zf - B.zr + .02;
      if (T.contra) { T.kmh = 0; state.speed = 0; }
      else state.speed = Math.min(state.speed, T.kmh);
    } else {
      // atrás: fica encostado na traseira do ego, sem passar (dando ré para cima dele, o ego para)
      T.z -= B.zf - E.zr + .02;
      if (state.re) state.speed = 0;
      else if (!T.contra) T.kmh = Math.min(T.kmh, state.speed);
    }
  }
}
function detectarColisao() {
  const C = world.colisao;
  if (C && C.fase !== 'carencia') return;
  const E = caixaEgo();
  for (const T of world.traffic.concat(world.contramao)) {
    if (C && C.id === T.id) continue;
    const B = caixa(T);
    const sobreZ = Math.min(E.zf, B.zf) - Math.max(E.zr, B.zr), sobreX = E.hw + B.hw - Math.abs(E.x - B.x);
    if (sobreZ <= 0 || sobreX <= 0) continue;
    // lateral quando a sobreposição de lado é a menor; senão, traseira (ego bate atrás), o ego é
    // atingido, ou frontal (veículo da contramão)
    const tipo = sobreX < sobreZ * .5 ? 'lateral' : T.contra ? 'frontal' : T.z > 0 ? 'traseira' : 'atingido por trás';
    colidir(T, tipo, sobreX, sobreZ);
    return;
  }
}
function colidir(T, tipo, sobreX) {
  const rel = T.contra ? state.speed + T.kmh : Math.abs(state.speed - T.kmh); // de frente: as velocidades somam
  // separa os dois (nenhuma visão mostra um veículo dentro do outro)
  if (tipo === 'lateral') {
    world.egoOffset += Math.sign(egoX() - T.x || 1) * (sobreX + .05);
    world.pull = world.pullFrac = world.egoOffset / PULL_DIST;
    world.lateralSpeed = 0;
  } else {
    const E = caixaEgo(), B = caixa(T);
    T.z += T.z > 0 ? E.zf - B.zr + .05 : E.zr - B.zf - .05;
  }
  // choque: as velocidades se aproximam (troca de quantidade de movimento simplificada)
  // de frente: os dois quase param no impacto; o da contramão fica parado (sem buzina nem farol,
  // com pisca-alerta) até o ego sair da faixa dele (veja updateContramao)
  if (T.contra) { state.speed *= .15; T.kmh *= .15; T.batido = true; }
  else {
    const media = (state.speed + T.kmh) / 2;
    state.speed += (media - state.speed) * .6; T.kmh += (media - T.kmh) * .6;
  }
  T.crash = true; T.seta = 0;
  world.colisao = { id: T.id, fase: 'parando', t: 0 };
  const nome = (isHeavy(T.kind) ? 'caminhão' : T.kind === 'van' ? 'van' : T.kind === 'pickup' ? 'picape' : 'carro');
  log(`Colisão (${tipo}) com ${nome} · diferença de ${Math.round(rel)} km/h: os dois veículos param`, 'colisao', { tipo, diferenca_kmh: Math.round(rel) });
  emit('colisao', { tipo, rel, kind: T.kind, lado: Math.sign(T.x - egoX()) });
}
function atualizarColisao(dt) {
  const C = world.colisao; if (!C) return;
  const T = world.traffic.find(t => t.id === C.id) || world.contramao.find(t => t.id === C.id);
  C.t += dt;
  if (C.fase === 'parando') {
    // o ego também freia (em updateSpeed); os dois ficam encostados, sem se sobrepor
    if (T) {
      const E = caixaEgo(), B = caixa(T);
      if (Math.min(E.zf, B.zf) > Math.max(E.zr, B.zr) && E.hw + B.hw > Math.abs(E.x - B.x)) T.z += T.z > 0 ? E.zf - B.zr + .02 : E.zr - B.zf - .02;
    }
    if (state.speed < .5 && (!T || T.kmh < .5)) { state.speed = 0; if (T) T.kmh = 0; C.fase = 'parado'; C.t = 0; log('Veículos parados após a colisão; retomada em 2 s', 'colisao'); }
  } else if (C.fase === 'parado') {
    if (C.t >= COLISAO.parado) {
      C.fase = 'carencia'; C.t = 0;
      if (T) { T.crash = false; T.kmh = 0; }
      log(state.controle === 'volante' ? 'Retomada: comandos liberados' : 'Retomada: velocidade voltando aos poucos', 'colisao');
      emit('retomada');
    }
  } else if (C.t >= COLISAO.carencia) world.colisao = null; // carência: não bate de novo no mesmo enquanto se afastam
}
const emColisao = () => !!world.colisao && world.colisao.fase !== 'carencia';
// Modo volante: limite para sair do acostamento quando há veículo na faixa ao lado (ou chegando
// por trás bem perto): o ego espera, todo no acostamento, até ter espaço.
function ladoLivre() {
  const ext = egoExtent();
  for (const T of world.traffic) {
    if (!naFaixa(T.x, T.width, 0)) continue;
    if (T.z - half(T.len) < ext.front + 3 && T.z + half(T.len) > -ext.rear - 6) return false;
  }
  return true;
}
// Extensão física do veículo próprio em relação ao motorista (z = 0), a da cabine 3D.
// Do olho do motorista ao para-choque dianteiro e ao traseiro (m). Carro (4,5 m): o capô fica uns
// 2,1 m à frente do motorista; caminhão de cabine avançada (16,5 m): 1,3 m.
function egoFisico() { return state.vehicle === 'truck' ? { front: 1.3, rear: 15.2 } : { front: 2.1, rear: 2.4 }; }
// Extensão do veículo próprio em relação ao motorista (z = 0). center = onde a 2D desenha o ego.
function egoExtent() {
  const phys = egoFisico();
  const center = (phys.front - phys.rear) / 2, h = Math.max((phys.front + phys.rear) / 2, half(vehicleLength(state.vehicle)));
  return { front: center + h, rear: h - center, center };
}

/* ---------- velocidade ---------- */
function updateSpeed(dt) {
  const v = VEHICLES[state.vehicle];
  let desired = state.target;
  const intervention = intervencao();
  const antes = state.speed;
  // colisão: os dois veículos freiam até parar e esperam a retomada (comandos travados)
  if (emColisao()) {
    if (state.re) { state.re = false; state.speed = 0; }
    if (world.colisao.fase === 'parando') state.speed = Math.max(0, state.speed - COLISAO.freio * dt);
    state.freando = true; state.target = state.speed;
    world.cantando = 0; world.cantandoAtivo = false;
    motor(dt, false, 0); return;
  }
  // intervenção: reduz até ~30 km/h enquanto encosta e só para depois de chegar ao acostamento
  if (intervention) desired = world.pull >= .98 ? 0 : Math.max(15, Math.min(state.speed, 30));
  if (state.controle === 'volante' && !intervention) { pedais(dt, v); motor(dt, false, state.re ? 0 : Math.max(0, VIGIA.controle?.pedal ?? 0)); return; }
  if (state.re) { state.re = false; state.speed = 0; } // a ré só existe no modo Volante
  world.cantando = 0; world.cantandoAtivo = false; // pneus cantando: só na frenagem do motorista (pedais)
  if (state.degraded) desired = state.speed;
  else if (!intervention && desired > 0) {
    state.cruiseT += dt;
    desired += Math.sin(state.cruiseT * .35) * 1.4 + Math.sin(state.cruiseT * 1.1) * .5;
  }
  // piloto automático adaptativo: segue o veículo à frente no caminho, a ~35 m
  const L = world.lead;
  if (L && !intervention) desired = Math.min(desired, Math.max(0, L.kmh + (L.z - half(L.len) - egoExtent().front - 35) * .4));
  if (state.speed > desired) {
    const drop = intervention ? v.decel * 3.6 * INTER_FREIO : Math.min(9, (state.speed - desired) * 2 + .5);
    state.speed = Math.max(desired, state.speed - drop * dt);
  } else if (state.speed < desired) {
    const corte = world.trocaT < .25 && world.trocaSobe ? .35 : 1; // torque cortado na troca de marcha
    state.speed = Math.min(desired, state.speed + Math.min(v.accel * 3.6 * .7, (desired - state.speed) * 2 + .5) * corte * dt);
  }
  // luz de freio: reduzindo de verdade (não a oscilação do piloto automático), ou na intervenção
  state.freando = dt > 0 && state.speed > .5 && ((antes - state.speed) / dt > 2.5 || intervention);
  const ganho = dt > 0 ? (state.speed - antes) / dt : 0; // km/h por segundo
  motor(dt, intervention, clamp((ganho - 1) / 5, 0, 1)); // carga: só enquanto ganha velocidade de verdade (ignora a oscilação do cruzeiro)
}
// Modo volante: acelerador e freio pelo eixo Y do controlador. Sem pedal, o veículo perde
// velocidade aos poucos (freio-motor). Nunca dá ré: a velocidade para em zero.
// Freio total: ~10 m/s² no carro (0,9 g, frenagem de emergência) e ~6 m/s² no caminhão.
const FREIO_FORCA = 4.6; // multiplica v.decel (m/s²) no freio total
/* Pneus cantando: só numa frenagem brusca a 120 km/h ou mais. Começa quando o pedal vai fundo de
 * repente (em até 0,3 s desde um freio leve) e o freio tira velocidade depressa: pelo menos 20 km/h
 * por segundo, ou seja, uns 30 km/h em 1,5 s. Freadas leves (que reduzem pouco) e qualquer freada
 * abaixo de 120 km/h não cantam. Uma vez começado, continua enquanto o freio seguir forte (15 km/h
 * por segundo ou mais) e o veículo andando, mais alto quanto mais rápido e mais fundo o pedal.
 * world.cantando 0..1 (audio.js e o rastro de pneus da 2D). */
const CANTAR = { velMin: 120, taxaMin: 20, taxaSegue: 15, janela: .3, velFim: 8 }; // km/h, km/h/s, s, km/h
function pneusCantando(dt, p, v) {
  const taxa = p < 0 ? -p * v.decel * 3.6 * FREIO_FORCA : 0; // km/h perdidos por segundo pelo freio
  // há quanto tempo o pedal estava leve (> -0,3): mede se a pisada foi brusca
  world.freioLeveT = p > -.3 ? 0 : (world.freioLeveT ?? 9) + dt;
  if (!world.cantandoAtivo && taxa >= CANTAR.taxaMin && world.freioLeveT <= CANTAR.janela && state.speed >= CANTAR.velMin) {
    world.cantandoAtivo = true;
    log('Frenagem brusca a ' + Math.round(state.speed) + ' km/h: pneus cantando', 'vehicle');
  }
  if (world.cantandoAtivo && (taxa < CANTAR.taxaSegue || state.speed < CANTAR.velFim)) world.cantandoAtivo = false;
  world.cantando = world.cantandoAtivo
    ? clamp((-p - .3) / .7, 0, 1) * clamp(state.speed / 150, .25, 1) * clamp((state.speed - CANTAR.velFim) / 15, 0, 1)
    : 0;
}
/* Ré (modo Volante): parado, segurar o freio por REVERSA.engata s engata a ré (R no painel); o
 * freio passa a levar o veículo para trás, devagar (até REVERSA.vmax), e o acelerador freia a ré;
 * parado de novo, o acelerador volta para D. Serve para sair de uma batida de frente, por exemplo.
 * A ré não retoma a estrada já percorrida: volta no máximo REVERSA.recuo m (o que a visão 2D mostra
 * atrás do veículo) a partir do ponto mais adiante a que ele já chegou; ali trava. */
const REVERSA = { engata: .5, vmax: 10, acel: 6, freio: 14, recuo: 8 }; // s, km/h, km/h/s, km/h/s, m
function re(dt, p) {
  if (p < -.05) state.speed = Math.min(REVERSA.vmax * -p, state.speed + REVERSA.acel * -p * dt); // freio: para trás
  else if (p > .05) state.speed = Math.max(0, state.speed - REVERSA.freio * p * dt);                // acelerador: freia a ré
  else state.speed = Math.max(0, state.speed - 4 * dt);                                             // solto: para aos poucos
  // limite: não volta além do que já passou
  const limite = (world.distanciaMax ?? world.distance) - REVERSA.recuo;
  if (world.distance - state.speed / 3.6 * dt <= limite) {
    state.speed = 0;
    if (!world.reLimite) { world.reLimite = true; log('Ré: limite atingido (não volta além do trecho à vista)', 'vehicle'); }
  } else world.reLimite = false;
  state.target = state.speed; state.freando = false;
  world.cantando = 0; world.cantandoAtivo = false;
  if (state.speed < .3 && p > .3) { state.re = false; log('Marcha D: ré desengatada', 'vehicle'); }
}
function pedais(dt, v) {
  const p = VIGIA.controle?.pedal ?? 0;  // -1 freio total .. 1 acelerador total
  if (state.re) { re(dt, p); return; }
  // parado e segurando o freio: engata a ré
  world.freioParadoT = state.speed < .3 && p < -.3 ? (world.freioParadoT || 0) + dt : 0;
  if (world.freioParadoT >= REVERSA.engata) { state.re = true; state.speed = 0; world.freioParadoT = 0; log('Marcha R: ré engatada (freio leva para trás, devagar)', 'vehicle'); return; }
  const max = v.maxSpeed;
  let a; // km/h por segundo
  if (p > 0) a = p * v.accel * 3.6 * 1.6 * clamp(1.15 - state.speed / max, 0, 1) * (world.trocaT < .25 && world.trocaSobe ? .3 : 1);
  else if (p < 0) a = p * v.decel * 3.6 * FREIO_FORCA;
  // pé fora dos pedais: freio-motor e atrito, ~3 a 5 km/h por segundo (bem menos que o freio, que
  // tira até ~36): de 100 a 60 km/h em ~9 s, parando aos poucos
  else a = -(3 + state.speed * .02);
  state.speed = clamp(state.speed + a * dt, 0, max);
  state.target = state.speed;
  state.freando = p < -.05; // pedal de freio apertado: a luz acende, mesmo parado
  pneusCantando(dt, p, v);
}
/* Câmbio automático ilustrativo (sem sensores reais). Cada marcha tem a velocidade em que o motor
 * chega ao giro máximo (TOPO); o giro é proporcional à velocidade nessa marcha. Sobe de marcha
 * mais cedo com o pé leve e mais tarde com o pé no fundo; reduz quando o giro cai demais (ou no
 * kickdown, ao pisar fundo). Uma troca por vez, com 0,7 s entre elas; cada troca avisa ('marcha')
 * o som, a mão do motorista e a tremida da tela. */
const CAMBIO = {
  car:   { topo: [0, 32, 58, 88, 125, 165, 215], giroMax: 6200, idle: 850, sobe: [2700, 3000], desce: [1700, 1500] },
  truck: { topo: [0, 12, 22, 32, 44, 56, 70, 86, 124], giroMax: 2300, idle: 650, sobe: [1450, 650], desce: [850, 500] },
};
const ESTOURO = { apos: 5, min: 5, max: 5, dura: .35 }; // 1º tiro após 5 s no máximo; depois, de 5 em 5 s
function motor(dt, intervention, carga) {
  world.distance += velEgo() / 3.6 * dt;
  world.odometer += state.speed / 3.6 * dt / 1000;
  world.distanciaMax = Math.max(world.distanciaMax ?? world.distance, world.distance); // até onde já chegou (limite da ré)
  const cb = CAMBIO[state.vehicle === 'truck' ? 'truck' : 'car'], N = cb.topo.length - 1;
  world.carga += (carga - world.carga) * clamp(dt * 5, 0, 1);
  // intenção imediata (sem a suavização da carga): pé no acelerador agora, ou o piloto automático
  // ganhando velocidade. Decide, sem atraso, se uma redução é kickdown ou freio-motor (áudio).
  world.acelerando = carga > .08;
  const k = world.carga, giro = g => cb.giroMax * state.speed / cb.topo[g];
  let g = clamp(world.marcha || 1, 1, N);
  world.trocaT += dt;
  if (world.trocaT > .7) {
    const sobe = cb.sobe[0] + cb.sobe[1] * k, desce = cb.desce[0] + cb.desce[1] * k;
    let nova = g;
    if (g < N && giro(g) > sobe) nova = g + 1;
    else if (g > 1 && giro(g) < desce && giro(g - 1) < sobe - 150) nova = g - 1;
    if (nova !== g) {
      world.trocaT = 0; world.trocaSobe = nova > g;
      if (state.speed > 2) emit('marcha', { de: g, para: nova, sobe: nova > g, carga: k, acelerando: world.acelerando });
      g = nova;
    }
  }
  if (state.speed < 2) g = 1;
  world.marcha = g;
  const targetRpm = Math.max(cb.idle, Math.min(cb.giroMax, giro(g)));
  world.rpm = lerp(world.rpm || cb.idle, targetRpm, clamp(dt * 7, 0, 1));
  // Limitador: na velocidade máxima com o pé no fundo, a injeção corta e volta ~10 vezes por
  // segundo; o giro bate no máximo e cai um pouco a cada corte ("randandandan" em audio.js).
  world.limitador = state.speed >= VEHICLES[state.vehicle].maxSpeed - .5 && world.carga > .5;
  if (world.limitador) world.rpm = cb.giroMax * (1 - .07 * ((motion.t * 10) % 1));
  // Muito tempo no limitador (ESTOURO.apos s seguidos): tiros no escapamento, um a cada
  // ESTOURO.min-max s, enquanto continuar no máximo. world.estouroT = s desde o último (animação da chama).
  world.limitadorT = world.limitador ? (world.limitadorT || 0) + dt : 0;
  world.estouroT = (world.estouroT ?? 9) + dt;
  if (world.limitadorT >= ESTOURO.apos) {
    if (!world.estourando) { world.estourando = true; world.estouroProx = 0; log('Muito tempo no limitador: estouros no escapamento', 'vehicle'); }
    if ((world.estouroProx -= dt) <= 0) {
      world.estouroProx = ESTOURO.min + Math.random() * (ESTOURO.max - ESTOURO.min);
      world.estouroT = 0; world.estouroForca = .7 + Math.random() * .3;
      emit('estouro', { forca: world.estouroForca });
    }
  } else world.estourando = false;
  world.gearNum = state.speed < 1 || state.re ? 0 : g;
  world.gear = state.re ? 'R' : state.speed < .5 && intervention ? 'P' : 'D';
}

/* ---------- acostamento ----------
 * Na intervenção, o veículo sai logo da faixa para o centro do acostamento enquanto reduz, e só
 * então para. A velocidade lateral chega a INTER_LAT m/s (~3 s da faixa ao acostamento, sem ser
 * uma manobra brusca) e é proporcional à de avanço (não desliza de lado parado). Quando a intervenção termina, volta à faixa só em movimento e
 * com espaço livre atrás e ao lado. Sem sinal (degradado), fica onde está. */
const PULL_DIST = ROAD.laneWidth + ROAD.shoulder / 2 - ROAD.egoLaneX; // até o centro do acostamento
const LAT_ACCEL = .9;    // m/s²: quanto a velocidade lateral pode mudar por segundo
const INTER_LAT = 1.4;   // m/s: velocidade lateral máxima entrando (ou saindo) do acostamento
const INTER_FREIO = 1.5; // multiplica v.decel na redução da intervenção (carro: ~3,3 m/s², firme sem ser pânico)
const STEER_MAX = 35;    // graus de volante, no máximo, para entrar ou sair do acostamento
const STEER_RATE = 70;   // graus por segundo: o motorista gira o volante aos poucos
const SETA_LIMIAR = .2;  // giro do volante (fração) a partir do qual a seta liga
const STEER_CONTROLADOR = 120; // graus de volante na cabine com o controlador todo virado
function mergeIsSafe() {
  const ext = egoExtent();
  return world.traffic.every(T => {
    if (!naFaixa(T.x, T.width, 0)) return true;
    const zf = T.z + half(T.len), zr = T.z - half(T.len);
    if (zr > ext.front) return zr - ext.front > 15;                                   // à frente
    if (zf < -ext.rear) return -ext.rear - zf > 30 + Math.max(0, T.kmh - state.speed) / 3.6 * 3; // atrás
    return false;                                                                      // ao lado
  });
}
// Modo volante: até onde o motorista pode ir (m, a partir do centro da faixa da direita): à
// esquerda, até a faixa de contramão (invadi-la é por conta e risco do motorista), até a roda
// encostar na linha de bordo; à direita, até o meio do acostamento.
function limitesVolante() {
  const meia = egoLargura() / 2;
  return [ROAD.contramao[1] - ROAD.egoLaneX - (ROAD.laneWidth / 2 - meia - .1), PULL_DIST]; // até a contramão externa
}
// Resposta progressiva: giro pequeno, correção suave; volante todo virado, troca de faixa rápida.
// lateral = sinal(x) · |x|^VOLANTE_CURVA · min(VOLANTE_LAT, velocidade · VOLANTE_GANHO)
// A 90 km/h, volante todo virado: troca de faixa em ~0,65 s (manobra brusca); meio volante, ~1,5 s.
const VOLANTE_LAT = 7.5;    // m/s de deslocamento lateral com o volante todo virado (em velocidade)
const VOLANTE_GANHO = .3;   // fração da velocidade de avanço (parado não anda de lado)
const VOLANTE_CURVA = 1.6;  // >1: o fim do curso do volante vira bem mais que o começo
const VOLANTE_ACC = 22;     // m/s²: resposta do veículo ao volante (alto: giro brusco responde na hora)
function updateLateral(dt) {
  const inter = !state.degraded && state.level === 'intervention';
  const v0 = world.lateralSpeed, before = world.pull;
  let v;
  if (emColisao()) {
    // batida: o veículo fica onde parou até a retomada
    world.lateralSpeed = 0; world.lateralAccel = 0;
    return;
  }
  if (state.controle === 'volante' && !inter) {
    // motorista no volante: o giro pede velocidade lateral, proporcional à de avanço (parado não anda de lado)
    const x = VIGIA.controle?.direcao ?? 0;
    // em manobra (devagar, inclusive na ré) o volante desloca mais por metro andado, como na vida real
    const vm = state.speed / 3.6, ganho = VOLANTE_GANHO + .25 * clamp(1 - vm / 8, 0, 1);
    // na ré o volante é invertido: virando para a esquerda, o veículo vai para a direita (e vice-versa)
    const alvo = (state.re ? -1 : 1) * Math.sign(x) * Math.pow(Math.abs(x), VOLANTE_CURVA) * Math.min(VOLANTE_LAT, vm * ganho);
    v = dt > 0 ? v0 + clamp(alvo - v0, -VOLANTE_ACC * dt, VOLANTE_ACC * dt) : v0;
    let [min, max] = limitesVolante();
    // todo no acostamento com veículo ao lado na faixa: não volta para a faixa (seria uma batida)
    if (world.pull >= NA_FAIXA && !ladoLivre()) min = Math.min(world.egoOffset, NA_FAIXA * PULL_DIST);
    let off = world.egoOffset + v * dt;
    if (off <= min) { off = min; v = Math.max(0, v); }
    if (off >= max) { off = max; v = Math.min(0, v); }
    world.egoOffset = off;
    world.pull = world.pullFrac = off / PULL_DIST;
    world.lateralSpeed = v;
  } else {
    // Alvo: acostamento na intervenção; de volta à faixa quando ela termina (só em movimento e com
    // espaço livre, se estiver no acostamento). Sem sinal (degradado), fica onde está.
    let alvoPull = null;
    if (inter) alvoPull = 1;
    else if (!state.degraded && world.pull < 0 && state.speed > 20 && mergeIsSafe()) alvoPull = 0; // da faixa da esquerda para a da direita
    else if (!state.degraded && world.pull > 0 && state.speed > 20 && mergeIsSafe()) alvoPull = 0;
    // Velocidade lateral contínua: sobe e desce com aceleração limitada (inclusive quando a volta
    // pausa por falta de espaço) e freia antes do fim, para o volante nunca dar tranco.
    const rate = Math.min(INTER_LAT, state.speed / 3.6 * .17); // m/s (a 30 km/h já é a máxima)
    const falta = alvoPull == null ? 0 : (alvoPull - world.pull) * PULL_DIST;
    const alvo = Math.sign(falta) * Math.min(rate, Math.sqrt(2 * LAT_ACCEL * Math.abs(falta)));
    v = dt > 0 ? v0 + clamp(alvo - v0, -LAT_ACCEL * dt, LAT_ACCEL * dt) : v0;
    let pull = world.pull + v * dt / PULL_DIST;
    if (alvoPull != null && falta !== 0 && (alvoPull - pull) * falta <= 0) { pull = alvoPull; v = 0; } // chegou
    world.pull = world.pullFrac = clamp(pull, Math.min(0, world.pull), 1);
    world.lateralSpeed = (world.pull === 1 && v > 0) ? 0 : v;
  }
  // aceleração lateral suavizada: é ela que pede volante (vira, depois desvira para alinhar)
  world.lateralAccel = lerp(world.lateralAccel, dt > 0 ? (world.lateralSpeed - v0) / dt : 0, clamp(dt * 6, 0, 1));
  world.egoOffset = world.pull * PULL_DIST;
  const lat = world.lateralSpeed;
  if (state.controle === 'volante' && !inter) {
    // rumo: a frente aponta para onde o veículo vai; na ré, para o lado contrário do deslocamento
    world.heading = lerp(world.heading, Math.atan2(state.re ? -lat : lat, Math.max(state.speed / 3.6, 2)), clamp(dt * 3, 0, 1));
    return; // o motorista manobra: sem os registros da intervenção
  }
  // rumo do veículo: inclina um pouco na direção da manobra, sem tranco
  world.heading = lerp(world.heading, Math.atan2(lat, Math.max(state.speed / 3.6, 2)), clamp(dt * 3, 0, 1));
  if (before === 0 && world.pull > 0) log('Intervenção: encostando no acostamento', 'intervention');
  if (before < 1 && world.pull === 1) log('Veículo no acostamento', 'intervention');
  if (before > 0 && world.pull === 0 && state.controle === 'padrao') { log('Veículo de volta à faixa', 'intervention'); world.posRetorno = 3; }
  world.posRetorno = Math.max(0, world.posRetorno - dt);
}

/* ---------- ciclo dia/noite (transição suave) ---------- */
function computeEnv() {
  const h = env.timeOfDay;
  // Elevação do sol: nascer 6h, pôr 18h.
  env.sunElevation = Math.sin((h - 6) / 12 * Math.PI);
  env.night = 1 - smooth(clamp((env.sunElevation + .12) / .32, 0, 1));
  env.phase = env.sunElevation > .2 ? 'DIA' : env.sunElevation > -.1 ? (h < 12 ? 'AMANHECER' : 'ENTARDECER') : 'NOITE';
  env.temperature = Math.round(19 + 9 * clamp((env.sunElevation + .2) / 1.2, 0, 1));
}
function updateEnv(dt) {
  if (env.warp) {
    const w = env.warp;
    w.t = Math.min(1, w.t + dt / w.dur);
    let span = (w.to - w.from + 24) % 24;
    env.timeOfDay = (w.from + span * smooth(w.t)) % 24;
    if (w.t >= 1) env.warp = null;
  } else {
    // dia inteiro em state.cycleMinutes minutos
    env.timeOfDay = (env.timeOfDay + dt * 24 / (state.cycleMinutes * 60)) % 24;
  }
  const wasNight = env.night > .5;
  computeEnv();
  if ((env.night > .5) !== wasNight) log(env.night > .5 ? 'Anoiteceu: iluminação noturna' : 'Amanheceu: iluminação diurna', 'environment', {}, true);
}
function toggleDayNight() {
  const goingNight = env.night < .5;
  env.warp = { from: env.timeOfDay, to: goingNight ? 21 : 9, t: 0, dur: 7 };
  log('Transição manual para ' + (goingNight ? 'noite' : 'dia'), 'environment');
}
function clockText() {
  const h = Math.floor(env.timeOfDay), m = Math.floor((env.timeOfDay - h) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* ---------- níveis de alerta ---------- */
function setLevel(level, source = 'manual') {
  if (!LEVELS.includes(level)) return;
  state.degraded = false; state.source = source;
  const changed = level !== state.level;
  state.level = level;
  if (level === 'critical') { state.ackDeadline = source === 'manual' ? now() + 8000 : 0; state.ackDone = false; state.driver = 'RESPOSTA PENDENTE'; }
  else if (level === 'attention') { state.driver = 'AVISADO'; state.ackDeadline = 0; }
  else if (level === 'intervention') { state.driver = 'INTERVENÇÃO'; state.ackDeadline = 0; }
  else { state.driver = 'AGUARDANDO'; state.ackDeadline = 0; state.target = cruiseFor(); }
  if (changed) { log('Nível de risco: ' + LABEL[level] + ' (' + source + ')', 'alert', { source }); state.alarmElapsed = 0; emit('level', level); }
  refreshUI();
}
// Degradado: mantém a velocidade atual e nunca freia.
function setDegraded(reason = 'Sinal perdido: sistema degradado; frenagem não aplicada') {
  if (state.degraded) return;
  state.degraded = true; state.degradedReason = reason;
  state.level = 'normal'; state.target = state.speed; state.ackDeadline = 0; state.driver = 'SEM SINAL';
  refreshUI(); emit('level', 'degraded');
  log(reason, 'degraded');
}
function acknowledge() {
  state.ackDone = true; state.ackDeadline = 0; state.driver = 'RESPONDEU';
  log('Motorista confirmou estar atento', 'driver_response');
  emit('resposta'); // sinal.js leva a resposta ao estimador (página ou WebSocket)
  if (state.source === 'manual' && state.level !== 'intervention' && !state.degraded) setLevel('normal', 'manual');
  else refreshUI();
}
function effectiveLevel() { return state.degraded ? 'degraded' : state.level; }

/* ---------- interface ---------- */
function refreshUI() {
  const l = effectiveLevel();
  LEVELS.forEach(a => $(a + 'Btn').classList.toggle('active', state.level === a && !state.degraded));
  $('scene').dataset.level = l;
}

/* ---------- largada ----------
 * Toda simulação começa parada: no Volante, o veículo espera o motorista acelerar; no Padrão, o
 * simulador acelera sozinho até a velocidade de cruzeiro. O logotipo VIGIA fica pintado no asfalto
 * LARGADA_LOGO m à frente do motorista (world.largada = posição na rodovia, em metros). */
const LARGADA_LOGO = 20;
function largada() {
  state.speed = 0; state.re = false;
  state.target = state.controle === 'volante' ? 0 : cruiseFor();
  Object.assign(world, { marcha: 1, trocaT: 1, carga: 0, rpm: 0, limitadorT: 0, estourando: false });
  world.largada = world.distance + LARGADA_LOGO;
  world.distanciaMax = world.distance;
  world.largadaT = 0; // s desde a largada (pista vazia nos primeiros LARGADA_VAZIA s)
}

/* ---------- comandos ---------- */
function setVehicle(v) {
  if (!VEHICLES[v]) return;
  state.vehicle = v; state.level = 'normal'; state.degraded = false;
  largada(); state.manualTarget = false;
  Object.assign(world, { pull: 0, pullFrac: 0, egoOffset: 0, lateralSpeed: 0, lateralAccel: 0, heading: 0, posRetorno: 0, colisao: null, marcha: 1, trocaT: 1 });
  state.driver = 'AGUARDANDO'; state.ackDone = false; state.ackDeadline = 0;
  seedTraffic();
  document.querySelectorAll('[data-vehicle]').forEach(b => { b.classList.toggle('active', b.dataset.vehicle === v); b.setAttribute('aria-pressed', b.dataset.vehicle === v); });
  $('cockpitVehicleLabel').textContent = VEHICLES[v].name;
  refreshUI();
  emit('vehicle', v);
  log('Veículo selecionado: ' + (v === 'car' ? 'carro familiar' : 'caminhão'), 'vehicle');
}
/* Troca de câmera animada (TROCA.dur s):
 *  - 2D -> cabine: a vista 2D se afasta (zoom out) e encolhe até caber na tela "Visão 2D" do painel
 *    da cabine, que vai aparecendo em volta; no fim, some dentro do tablet;
 *  - cabine -> 2D: o caminho inverso, um zoom para dentro do tablet até a 2D ocupar a tela toda.
 * As duas vistas são desenhadas durante a troca; vistaAtiva(m) diz se a vista m precisa ser
 * desenhada. Com "reduzir movimento", troca direto. */
const TROCA = { dur: .85 };
const troca = { ativa: false, de: '2d', para: '2d', t: 0 };
const vistaAtiva = m => state.viewMode === m || troca.ativa;
function setViewMode(v) {
  if (!['2d', '3d'].includes(v)) return;
  const antes = state.viewMode;
  state.viewMode = v;
  const sc = $('scene');
  if (antes !== v && !state.reduceMotion && VIGIA.world3d?.ready && !VIGIA.world3d.falhou) {
    Object.assign(troca, { ativa: true, de: antes, para: v, t: troca.ativa ? TROCA.dur - troca.t : 0 });
    sc.classList.add('trocando');
    sc.classList.add('cockpit-view');           // a cabine fica montada durante toda a troca
    VIGIA.world3d.resize?.();                      // já com o tamanho certo (antes estava oculta)
    telaAplicada = null;
  } else {
    if (troca.ativa) fimDaTroca();
    sc.classList.toggle('cockpit-view', v === '3d');
  }
  $('view2dBtn').classList.toggle('selected', v === '2d'); $('view3dBtn').classList.toggle('selected', v === '3d');
  $('view2dBtn').setAttribute('aria-pressed', v === '2d'); $('view3dBtn').setAttribute('aria-pressed', v === '3d');
  emit('view', v);
  log(v === '3d' ? 'Modo cabine 3D ativado' : 'Visão superior 2D ativada', 'view');
}
function setPaused(p) {
  state.paused = p;
  $('scene').classList.toggle('paused', p);
  log(p ? 'Simulação pausada' : 'Simulação retomada', 'pause');
}
function reset() {
  VIGIA.sinal?.fecharCanal('Cenário reiniciado: canal de sinal fechado');
  Object.assign(state, { degraded: false, source: 'manual', level: 'normal', driver: 'AGUARDANDO', ackDeadline: 0, ackDone: false, hazardOn: false, alarmElapsed: 0, returning: false, leftOn: false, rightOn: false, seta: null });
  largada(); state.manualTarget = false;
  Object.assign(world, { pull: 0, pullFrac: 0, egoOffset: 0, lateralSpeed: 0, lateralAccel: 0, heading: 0, posRetorno: 0, colisao: null, marcha: 1, trocaT: 1 });
  seedTraffic();
  if (state.paused) setPaused(false);
  refreshUI(); emit('level', 'normal');
  log('Cenário reiniciado', 'reset');
}
function exportLog() {
  if (!state.events.length) log('Não havia eventos; adicionada marca de exportação', 'export');
  const data = state.events.map(e => JSON.stringify(e)).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([data], { type: 'application/x-ndjson;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'vigia_eventos_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ---------- movimento do veículo (volante, balanço da cabine, rolagem) ----------
 * Compartilhado pela cabine (volante/painel) e pela câmera 3D, para tudo se mover junto. */
const motion = { t: 0, steer: 0, manobra: 0, roll: 0, bob: 0, kick: 0, marcha: 0, batida: 0, tela: { x: 0, y: 0, r: 0, s: 1 } };
function updateMotion(dt) {
  const k = clamp(state.speed / 40, 0, 1) * (state.reduceMotion ? 0 : 1), t = (motion.t += dt);
  motion.kick = Math.max(0, motion.kick - dt * 2.2);
  const jolt = motion.kick * (Math.sin(t * 31) * .6 + Math.sin(t * 17) * .4);
  // entra e sai do acostamento: vira e desvira, limitado e sem saltos (nunca dá a volta no volante)
  const inter = !state.degraded && state.level === 'intervention';
  if (state.controle === 'volante' && !inter) {
    // o volante da cabine acompanha o do controlador (giro do eixo X)
    const alvo = (VIGIA.controle?.direcao ?? 0) * STEER_CONTROLADOR;
    motion.manobra = lerp(motion.manobra, alvo, clamp(dt * 18, 0, 1));
    motion.steer = motion.manobra;
  } else {
    const manobra = clamp(world.lateralSpeed * 9 + world.lateralAccel * 12, -STEER_MAX, STEER_MAX);
    motion.manobra += clamp(manobra - motion.manobra, -STEER_RATE * dt, STEER_RATE * dt);
    // pequenas correções do motorista; na intervenção (motorista desacordado) só a manobra automática
    motion.steer = (inter ? 0 : (Math.sin(t * .33) * 1.5 + Math.sin(t * .91 + 1.3) * .6 + Math.sin(t * 2.3) * .12) * k) + motion.manobra; // graus
  }
  motion.roll = ((Math.sin(t * .47) * .16 + Math.sin(t * 1.3) * .06) * k + jolt * .25) * Math.PI / 180;
  motion.bob = (Math.sin(t * 1.9) * .8 + Math.sin(t * 5.1 + .5) * .35) * k + jolt * 1.6; // px
  tremida(dt);
}
/* Tremida da tela (2D e 3D): a vista inteira (#view2d e #view3d) se desloca alguns pixels.
 *  - velocidade: começa em 110 km/h e cresce até a máxima (vibração fina e contínua);
 *  - troca de marcha: um tranco curto para frente e para trás (motion.marcha, 0,35 s);
 *  - colisão: um solavanco forte que se acalma em ~1 s (motion.batida).
 * Com "reduzir movimento" ligado, só a batida treme, bem de leve. */
function tremida(dt) {
  const calmo = state.reduceMotion, t = motion.t;
  motion.marcha = Math.max(0, motion.marcha - dt / .35);
  motion.batida = Math.max(0, motion.batida - dt / 1.1);
  const vel = calmo ? 0 : smooth(clamp((state.speed - 110) / (VEHICLES[state.vehicle].maxSpeed - 110), 0, 1));
  const m = calmo ? 0 : Math.sin((1 - motion.marcha) * Math.PI) * motion.marcha; // sobe e desce numa troca
  const b = motion.batida * motion.batida * (calmo ? .25 : 1);
  const ruido = f => Math.sin(t * f) * .6 + Math.sin(t * f * 1.73 + 1.1) * .4;
  // Velocidade: só uma vibração vertical leve e lenta (~2,5 Hz, até 0,7 px), sem giro nem zoom.
  // Antes era rápida (~6 Hz), com deslocamento lateral, giro e zoom da tela inteira: em alta
  // velocidade parecia que o jogo estava travando.
  motion.tela.x = b * 14 * ruido(23);
  motion.tela.y = vel * .7 * ruido(16) + m * 5 + b * 10 * ruido(19);
  motion.tela.r = b * 1.2 * ruido(13); // graus
  motion.tela.s = 1 + (m * 5 + b * 16) / 600 + (vel ? .0025 : 0); // amplia um pouco para não mostrar as bordas
}
// passagem colada (mesmo sentido, faixa ao lado): um tranco leve; quem passa na contramão, duas faixas
// além, não sacode o carro (a 200 km/h, cruzando com ~300 km/h de diferença, sacudia o tempo todo)
on('pass', t => { if (t.rel > 25 && !t.contra) motion.kick = Math.max(motion.kick, (isHeavy(t.kind) ? .5 : .18) * clamp(t.rel / 80, .3, 1)); });
on('marcha', () => { motion.marcha = 1; });
on('estouro', e => { motion.marcha = Math.max(motion.marcha, .6 * e.forca); });
on('buzinaInicio', () => pedirPassagem());
on('colisao', c => { motion.batida = 1; motion.kick = 1.6; });
function fimDaTroca() {
  troca.ativa = false;
  const sc = $('scene');
  sc.classList.remove('trocando');
  sc.classList.toggle('cockpit-view', state.viewMode === '3d');
  for (const id of ['view2d', 'view3d']) { const el = $(id); el.style.transform = el.style.transformOrigin = el.style.clipPath = el.style.opacity = ''; }
  telaAplicada = null;
}
// e = 0: só a 2D, em tela cheia; e = 1: a cabine, com a 2D dentro do tablet. A cabine é ampliada
// em torno do tablet (que ocupa a largura da tela em e = 0) e a 2D acompanha o tablet: mesma
// escala, mesmo centro, recortada no formato dele. Zoom em escala logarítmica (ritmo constante).
function quadroDaTroca(dt) {
  troca.t += dt;
  const p = clamp(troca.t / TROCA.dur, 0, 1);
  if (p >= 1) { fimDaTroca(); return; }
  const k = smooth(smooth(p)), e = troca.para === '3d' ? k : 1 - k;
  const sc = $('scene'), W = sc.clientWidth, H = sc.clientHeight;
  const r = VIGIA.cabin?.telaMini?.();
  if (!r || !W || !H) return;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const Z = Math.exp(Math.log(W / r.w) * (1 - e));          // ampliação da cabine
  const px = lerp(W / 2, cx, e), py = lerp(H / 2, cy, e);    // onde o centro do tablet aparece
  const v3 = $('view3d'), v2 = $('view2d');
  v3.style.transformOrigin = v2.style.transformOrigin = '0 0';
  v3.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) scale(${Z.toFixed(4)}) translate(${-cx.toFixed(1)}px,${-cy.toFixed(1)}px)`;
  const s2 = Z * r.w / W;                                    // a 2D tem a largura do tablet ampliado
  v2.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) scale(${s2.toFixed(4)}) translate(${(-W / 2).toFixed(1)}px,${(-H / 2).toFixed(1)}px)`;
  // recorte no formato do tablet (em coordenadas da própria 2D, antes da escala)
  const hj = lerp(H, r.h * W / r.w, e), mv = Math.max(0, (H - hj) / 2), raio = lerp(0, 6 * W / r.w, e);
  v2.style.clipPath = `inset(${mv.toFixed(1)}px 0px ${mv.toFixed(1)}px 0px round ${raio.toFixed(1)}px)`;
  // perto do tablet, a 2D se dissolve na tela da cabine (que mostra a mesma cena)
  v2.style.opacity = (1 - smooth(clamp((e - .72) / .28, 0, 1))).toFixed(3);
}
let telaAplicada = '';
function aplicarTremida(dt) {
  if (troca.ativa) { quadroDaTroca(dt); return; }
  const T = motion.tela;
  const css = Math.abs(T.x) + Math.abs(T.y) + Math.abs(T.r) < .01 && T.s < 1.0005 ? '' : `translate(${T.x.toFixed(2)}px,${T.y.toFixed(2)}px) rotate(${T.r.toFixed(3)}deg) scale(${T.s.toFixed(4)})`;
  if (css === telaAplicada) return;
  telaAplicada = css;
  for (const id of ['view2d', 'view3d']) { const el = $(id); if (el) el.style.transform = css; }
}

/* Flash da câmera VIGIA: luz branca que pulsa no rosto do motorista para despertá-lo.
 *  - crítico: pulso fraco, um a cada 2 s;
 *  - intervenção: pulso mais forte, um a cada 2,5 s.
 * Pensado para quem tem fotossensibilidade (epilepsia): no máximo 1 pulso a cada 2 s (bem abaixo do
 * limite de 3 por segundo), sem estalo de luz (acende e apaga devagar, em ~0,6-0,8 s) e sem chegar
 * ao branco total. Com "reduzir movimento", 30% da força. state.flash = 0..1. */
const FLASH = { critical: { periodo: 2, dur: .6, forca: .14 }, intervention: { periodo: 2.5, dur: .8, forca: .42 } };
function flashVigia(dt) {
  const f = FLASH[effectiveLevel()];
  if (!f) { state.flash = 0; state.flashT = 0; return; }
  state.flashT = (state.flashT || 0) + dt;
  const fase = state.flashT % f.periodo;
  const s = fase < f.dur ? Math.sin(Math.PI * fase / f.dur) : 0;
  state.flash = s * s * f.forca * (state.reduceMotion ? .3 : 1); // seno² : sobe e desce sem quina
}

/* ---------- laço principal ---------- */
let lastFrame = 0;
const renderers = [];
const inputs = []; // leitura de controladores, antes da física de cada quadro
/* Medidor de desempenho (desligado por padrão): VIGIA.perf.ligar() mede o tempo de CPU de cada
 * etapa do quadro (entradas, simulação e cada renderizador, pelo nome da função e do arquivo);
 * VIGIA.perf.relatorio() devolve a média e o pico por etapa e o intervalo entre quadros. */
const perf = { on: false, dados: {}, quadros: 0, intervalos: [],
  ligar() { this.on = true; this.dados = {}; this.quadros = 0; this.intervalos = []; },
  desligar() { this.on = false; },
  somar(nome, ms) { const d = this.dados[nome] || (this.dados[nome] = { soma: 0, max: 0 }); d.soma += ms; d.max = Math.max(d.max, ms); },
  relatorio() {
    const r = {}, n = Math.max(1, this.quadros);
    for (const [k, d] of Object.entries(this.dados)) r[k] = { media_ms: +(d.soma / n).toFixed(2), pico_ms: +d.max.toFixed(1) };
    const iv = this.intervalos.slice().sort((a, b) => a - b);
    r._quadro = { quadros: this.quadros, intervalo_medio_ms: +(iv.reduce((a, b) => a + b, 0) / Math.max(1, iv.length)).toFixed(1), p95_ms: +(iv[Math.floor(iv.length * .95)] || 0).toFixed(1) };
    return r;
  },
};
function medir(nome, fn) {
  if (!perf.on) return fn();
  const t0 = performance.now();
  try { return fn(); } finally { perf.somar(nome, performance.now() - t0); }
}
const nomeDe = (f, i) => f.etiqueta || (f.name || 'anon') + '#' + i;
function frame(time) {
  const dt = Math.min((time - (lastFrame || time)) / 1000, .08);
  if (perf.on && lastFrame) { perf.quadros++; perf.intervalos.push(time - lastFrame); }
  lastFrame = time;
  inputs.forEach((f, i) => { try { medir('entrada:' + nomeDe(f, i), () => f(dt)); } catch (e) { console.error(e); } });
  if (!state.paused) medir('simulacao', () => simular(dt));
  aplicarTremida(dt);
  renderers.forEach((r, i) => { try { medir('desenho:' + nomeDe(r, i), () => r(dt, time)); } catch (e) { console.error(e); } });
  requestAnimationFrame(frame);
}
function simular(dt) {
  {
    updateSpeed(dt);
    updateLateral(dt);
    updateTraffic(dt);
    updateEnv(dt);
    updateMotion(dt);
    updateZones(dt);
    updatePeds(dt);
    const inter = !state.degraded && state.level === 'intervention';
    // Luz de freio: acesa enquanto o freio estiver acionado (pedal, frenagem automática ou a
    // redução da intervenção) e por mais 0,3 s, para não piscar com o ruído do eixo do controlador.
    const batida = emColisao();
    state.freioT = state.freando || batida || (inter && state.speed > .5) ? .3 : Math.max(0, (state.freioT || 0) - dt);
    state.luzFreio = state.freioT > 0;
    // de volta à faixa (fim da intervenção, ainda no acostamento): seta para a esquerda até entrar
    const volante = state.controle === 'volante' && !inter;
    const returning = !volante && !inter && !state.degraded && world.pull > 0;
    if (returning !== state.returning) {
      state.returning = returning;
      if (returning) { state.blinkElapsed = .55; log('Seta para a esquerda: retornando à faixa', 'intervention'); }
      else state.leftOn = false;
    }
    // no modo volante, a seta segue o volante: virou para a esquerda, seta esquerda; para a direita, seta direita
    const x = volante ? VIGIA.controle?.direcao ?? 0 : 0;
    const seta = returning ? 'esq' : x < -SETA_LIMIAR ? 'esq' : x > SETA_LIMIAR ? 'dir' : null;
    if (seta !== state.seta) {
      state.seta = seta; state.leftOn = state.rightOn = false;
      if (seta) state.blinkElapsed = .55; // acende já
    }
    flashVigia(dt);
    state.blinkElapsed += dt; state.alarmElapsed += dt;
    if (state.blinkElapsed > .55) {
      state.blinkElapsed = 0;
      state.hazardOn = inter || batida ? !state.hazardOn : false; // pisca-alerta: intervenção ou batida
      state.leftOn = seta === 'esq' ? !state.leftOn : false;
      state.rightOn = seta === 'dir' ? !state.rightOn : false;
      world.pisca = !world.pisca; // fase das setas e do pisca-alerta do tráfego
      if (inter || batida) emit('blink', state.hazardOn);
      else if (seta) emit('blink', state.leftOn || state.rightOn);
    }
    if ((state.level === 'critical' || state.level === 'intervention' || state.level === 'attention') && !state.degraded) {
      const every = state.level === 'attention' ? 6 : state.level === 'critical' ? 2.6 : 2.2;
      if (state.alarmElapsed > every) { state.alarmElapsed = 0; emit('alarm', state.level); }
    }
    if (state.ackDeadline && now() > state.ackDeadline && !state.ackDone) {
      state.ackDeadline = 0; state.driver = 'SEM RESPOSTA'; refreshUI();
      log('Prazo de resposta do motorista excedido', 'timeout');
    }
  }
}

function bind() {
  document.querySelectorAll('[data-vehicle]').forEach(b => b.onclick = () => setVehicle(b.dataset.vehicle));
  // botões manuais assumem o comando: fecham o canal de sinal ativo
  LEVELS.forEach(l => $(l + 'Btn').onclick = () => { VIGIA.sinal?.fecharCanal('Modo manual: canal de sinal fechado'); setLevel(l, 'manual'); });
  $('view2dBtn').onclick = () => setViewMode('2d');
  $('view3dBtn').onclick = () => setViewMode('3d');
  $('exportBtn').onclick = exportLog;
  $('importReplayBtn').onclick = () => $('replayFile').click();
  $('replayFile').onchange = e => VIGIA.sinal?.importarReplay(e.target.files[0]);
  $('clearLogBtn').onclick = () => { state.events = []; $('log').replaceChildren(); $('eventCount').textContent = '0 eventos'; };
  $('settingsBtn').onclick = () => {
    $('settingsModal').classList.add('open');
    $('volume').value = Math.round(state.volume * 100); $('trafficDensity').value = state.trafficDensity;
    $('cycleMinutes').value = state.cycleMinutes; $('zoneSeconds').value = state.zoneSeconds; $('reduceMotion').checked = state.reduceMotion; syncSettingsLabels();
  };
  $('closeSettings').onclick = () => $('settingsModal').classList.remove('open');
  $('settingsModal').onclick = e => { if (e.target === $('settingsModal')) $('settingsModal').classList.remove('open'); };
  $('volume').oninput = e => { state.volume = e.target.value / 100; syncSettingsLabels(); emit('volume', state.volume); };
  $('trafficDensity').oninput = e => { state.trafficDensity = Number(e.target.value); syncSettingsLabels(); };
  $('cycleMinutes').oninput = e => { state.cycleMinutes = Number(e.target.value); syncSettingsLabels(); };
  $('zoneSeconds').oninput = e => { state.zoneSeconds = Number(e.target.value); syncSettingsLabels(); };
  $('reduceMotion').onchange = e => { state.reduceMotion = e.target.checked; };
  // Tela cheia dividida: simulação à esquerda e câmera/controles à direita (a câmera nunca some).
  $('fullscreenBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.querySelector('.app-grid').requestFullscreen?.().catch(() => {});
  };
  const viewSwitch = document.querySelector('.view-switch'), viewHome = viewSwitch.parentNode;
  document.addEventListener('fullscreenchange', () => {
    const fsLabel = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
    $('fullscreenBtn').title = fsLabel; $('fullscreenBtn').setAttribute('aria-label', fsLabel);
    (document.fullscreenElement ? $('monitorCard') : viewHome).appendChild(viewSwitch);
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea')) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); setPaused(!state.paused); }
    else if (k === 'v') setViewMode(state.viewMode === '2d' ? '3d' : '2d');
    else if (k === 'n') toggleDayNight();
    else if (k === 'a') acknowledge();
    else if (k === 'h') { if (!e.repeat) emit('buzinaInicio'); } // buzina enquanto a tecla estiver apertada
    else if (k === 'c') scheduleZoneSwitch(250); // atalho: troca de cenário logo à frente
    else if (['1', '2', '3', '4'].includes(k)) setLevel(LEVELS[Number(k) - 1], 'manual');
  });
  document.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'h') emit('buzinaFim'); });
  addEventListener('blur', () => emit('buzinaFim'));
}
function syncSettingsLabels() {
  $('volumeLabel').textContent = Math.round(state.volume * 100) + '%';
  $('densityLabel').textContent = ['', 'Baixa', 'Média', 'Alta'][state.trafficDensity];
  $('cycleLabelSetting').textContent = state.cycleMinutes + ' min por dia completo';
  const zs = state.zoneSeconds;
  $('zoneLabelSetting').textContent = zs < 60 ? zs + ' s' : (zs / 60).toLocaleString('pt-BR') + ' min';
}

const VIGIA = window.VIGIA = {
  version: '0.8.0', state, world, env, motion, VEHICLE_TYPES, WORLD_WRAP, CROSSINGS,
  cityAmount, cityRanges, crossingsBetween, nearCrossing, scheduleZoneSwitch, zoneAt, postalEm, POSTAL_MEIO, ROAD, VEHICLES, LABEL, DISPLAY_SCALE, egoExtent, CAMBIO, ESTOURO,
  clamp, lerp, smooth, on, emit, log, signsBetween, clockText, effectiveLevel,
  setLevel, setDegraded, refreshUI, setVehicle, setViewMode, vistaAtiva, troca, TROCA, reset, acknowledge, toggleDayNight,
  addRenderer: (fn, etiqueta) => { if (etiqueta) fn.etiqueta = etiqueta; renderers.push(fn); },
  perf, medir,
  addInput: fn => inputs.push(fn),
  getState: () => ({ night: env.night > .5, nightAmount: env.night, timeOfDay: env.timeOfDay, viewMode: state.viewMode, vehicle: state.vehicle, level: state.level, speed: state.speed, target: state.target, degraded: state.degraded, traffic: world.traffic.length, audioActive: !!VIGIA.audio?.enabled, cameraActive: !!VIGIA.monitor?.cameraActive }),
  trafficSnapshot: () => world.traffic.map(t => ({ id: t.id, z: t.z, x: t.x, lane: t.lane, kmh: t.kmh, kind: t.kind, len: t.len, crash: t.crash })),
  // avança a simulação sem depender da animação (testes automatizados)
  step: (dt = 1 / 30) => { updateSpeed(dt); updateLateral(dt); updateTraffic(dt); },
  // um quadro inteiro sem desenhar: controladores e toda a simulação (setas, alarmes, volante)
  passo: (dt = 1 / 30) => { for (const f of inputs) f(dt); simular(dt); },
  setTimeOfDay: h => { env.warp = null; env.timeOfDay = ((h % 24) + 24) % 24; computeEnv(); }
};

document.addEventListener('DOMContentLoaded', () => {
  computeEnv();
  bind();
  largada();
  seedTraffic(); initPeds();
  refreshUI(); syncSettingsLabels();
  emit('ready');
  log('Simulador VIGIA (Parte 3) pronto · scanner e câmera opcionais', 'startup');
  requestAnimationFrame(frame);
});
})();
