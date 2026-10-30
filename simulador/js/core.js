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
const DESCRIPTION = {
  normal: 'Condução simulada dentro das condições normais. Sem frenagem automática.',
  attention: 'Sinais de fadiga simulados. Aviso inicial ao motorista, sem reduzir a velocidade.',
  critical: 'Risco elevado de sonolência. Solicitação de confirmação do motorista.',
  intervention: 'Comando explícito de intervenção: pisca-alerta ligado e desaceleração simulada.',
  degraded: 'Comunicação perdida com a Parte 2. Nenhum comando novo de frenagem é aplicado.'
};
const BANNER = {
  normal: ['CONDUÇÃO NORMAL', 'Monitoramento em demonstração'],
  attention: ['ATENÇÃO · POSSÍVEL FADIGA', 'Atenção do motorista solicitada'],
  critical: ['ALERTA CRÍTICO', 'Confirme que está atento'],
  intervention: ['INTERVENÇÃO · POSSÍVEL SONOLÊNCIA', 'Pisca-alerta ligado · desaceleração simulada'],
  degraded: ['SISTEMA DEGRADADO', 'Sem frenagem por perda de sinal']
};

const VEHICLES = {
  car: { name: 'CARRO FAMILIAR', maxSpeed: 160, cruise: 90, decel: 2.2, accel: 2.4 },
  truck: { name: 'CAMINHÃO', maxSpeed: 120, cruise: 75, decel: 1.3, accel: 1.1 }
};

// Geometria da via (metros). Mão dupla: faixa própria à direita (x>0), contrária à esquerda.
const ROAD = { laneWidth: 3.6, shoulder: 2.6, egoLaneX: 1.8, oppositeLaneX: -1.8, railOffset: 6.5 };

const VIGIA_SIGN_EVERY = 1500;

const state = {
  vehicle: 'car', level: 'normal', degraded: false, source: 'manual',
  speed: 80, target: 80, manualTarget: false, paused: false,
  driver: 'AGUARDANDO', ackDeadline: 0, ackDone: false,
  hazardOn: false, blinkElapsed: 0, alarmElapsed: 0, cruiseT: 0,
  viewMode: '2d', reduceMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
  trafficDensity: 2, cycleMinutes: 4, zoneSeconds: 30, volume: .45,
  events: [], eventSeq: 0,
  channel: null, lastSignal: null, degradedReason: '',
  passCount: 0
};

const world = {
  distance: 0,        // metros percorridos
  odometer: 123456.0, // km ilustrativos
  traffic: [],        // veículos no sentido oposto: {id, z, kmh, kind, color}
  lead: null,         // veículo à frente na faixa própria
  follower: null,     // veículo atrás (aparece nos retrovisores)
  spawnTimer: 0, nextId: 1, rpm: 0, gear: 'D', gearNum: 1
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
const CITY_NAMES = ['MANHUAÇU', 'MATIPÓ'];
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
function scheduleZoneSwitch(ahead = 600) {
  const last = world.zones[world.zones.length - 1];
  const type = last.type === 'city' ? 'field' : 'city';
  const z = { type, start: Math.max(world.distance + ahead, last.start + 400) };
  if (type === 'city') z.name = CITY_NAMES[cityCount++ % CITY_NAMES.length];
  world.zones.push(z); zoneClock = 0;
  log(type === 'city' ? `Aproximando-se de ${z.name}: perímetro urbano a ${Math.round(z.start - world.distance)} m` : 'Fim do perímetro urbano à frente', 'environment');
  emit('zone', z);
}
function updateZones(dt) {
  if (state.speed > 1) zoneClock += dt; // conta só o tempo em movimento
  if (zoneClock >= state.zoneSeconds) scheduleZoneSwitch();
  const z = world.zones; // descarta zonas que já ficaram bem para trás
  while (z.length > 2 && z[1].start < world.distance - 2500) { z.shift(); z[0].start = -1e9; }
  const inCity = cityAmount(world.distance) > .5;
  if (inCity !== world.inCity) { world.inCity = inCity; const zz = zoneAt(world.distance); log(inCity ? `Perímetro urbano: ${zz.name}` : 'Rodovia: saída do perímetro urbano', 'environment'); emit('inCity', inCity); }
}

// Pedestres nas calçadas (só existem dentro da cidade). x = lateral (±7.4..9.8 m).
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
        Object.assign(p, { active: true, S, x: side * (7.4 + Math.random() * 2.3), dir: Math.random() < .5 ? 1 : -1 });
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
  { at: 1000, type: 'noPassing' }, // regulamentação: proibido ultrapassar
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
// A visão 2D desenha os veículos ampliados para leitura; os espaçamentos usam o
// comprimento ampliado para que nenhum veículo se sobreponha em nenhuma das visões.
const DISPLAY_SCALE = 2.1;
const half = len => len * DISPLAY_SCALE / 2;
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function spawnOncoming(z = 420) {
  if (world.traffic.length >= 22) return false;
  const v = randomVehicle(), kind = v.kind, len = v.len;
  const far = world.traffic.reduce((m, t) => !m || t.z > m.z ? t : m, null);
  if (far && z - far.z < half(len) + half(vehicleLength(far.kind)) + 12 + Math.random() * 10) return false;
  world.traffic.push({ id: world.nextId++, z, ...v, kmh: isHeavy(kind) ? 68 + Math.random() * 14 : 78 + Math.random() * 18, passed: false });
  return true;
}
function seedTraffic() {
  world.traffic = [];
  [14, 32, 55, 120, 200, 300].forEach(z => spawnOncoming(z));
  world.lead = { z: 52, ...randomVehicle(), kmh: state.speed };
  world.follower = { z: -egoExtent().rear - 34, ...randomVehicle(['truck', 'toco', 'pickup', 'van', 'truck34']), kmh: state.speed };
}

function updateTraffic(dt) {
  const ego = state.speed / 3.6;
  world.spawnTimer += dt;
  const interval = [0, 3.4, 1.9, 1.1][state.trafficDensity] * (90 / Math.max(40, state.speed + 50));
  if (world.spawnTimer >= interval) { world.spawnTimer = 0; spawnOncoming(); }

  world.traffic.sort((a, b) => a.z - b.z); // mais próximo primeiro
  let front = null; // veículo oposto mais próximo de nós (está "à frente" dele no sentido dele)
  for (const t of world.traffic) {
    const prev = t.z;
    let z = t.z - (ego + t.kmh / 3.6) * dt;
    if (front) z = Math.max(z, front.z + half(front.len) + half(t.len) + 6);
    t.z = Math.min(prev, z);
    if (!t.passed && t.z <= 0) { t.passed = true; state.passCount++; emit('pass', t); }
    front = t;
  }
  world.traffic = world.traffic.filter(t => t.z > -320); // segue visível nos retrovisores até sumir na distância

  // Mesma faixa: veículo à frente e veículo atrás seguem um modelo de car-following (IDM).
  // Ninguém atravessa nem ultrapassa o veículo próprio; o de trás freia e para se for preciso.
  const ext = egoExtent();
  const L = world.lead;
  if (L) {
    const intervention = state.level === 'intervention' && !state.degraded;
    const gap = L.z - half(L.len) - ext.front; // para-choque a para-choque
    const wantGap = 40 + Math.sin(world.distance / 260) * 10;
    // o da frente acompanha o ego mantendo distância; na intervenção segue viagem e se afasta
    const targetKmh = intervention ? 80 : Math.max(0, state.speed + clamp((wantGap - gap) * .3, -10, 10));
    L.kmh = lerp(L.kmh, targetKmh, clamp(dt * .7, 0, 1));
    L.z += (L.kmh / 3.6 - ego) * dt;
    if (L.z > 420) { // saiu de vista à frente: um novo veículo surge ao longe, na mesma faixa
      Object.assign(L, randomVehicle());
      L.z = 380; L.kmh = Math.max(state.speed - 15, 30);
    }
    L.z = Math.max(L.z, ext.front + half(L.len) + 4); // nunca encosta no ego
  }
  const F = world.follower;
  if (F) {
    const v = F.kmh / 3.6, gap = -ext.rear - (F.z + half(F.len)); // espaço livre até a traseira do ego
    const dv = v - ego;                       // aproximação (>0 = está chegando)
    const v0 = Math.max(cruiseFor(), 30) / 3.6 + 2;
    const a = 1.6, b = 3.2, s0 = 5, T = 1.3;
    const sStar = s0 + Math.max(0, v * T + v * dv / (2 * Math.sqrt(a * b)));
    let acc = a * (1 - Math.pow(v / v0, 4) - Math.pow(sStar / Math.max(gap, .5), 2));
    acc = clamp(acc, -9, a);
    F.kmh = Math.max(0, (v + acc * dt) * 3.6);
    F.z += (F.kmh / 3.6 - ego) * dt;
    // garantia física: nunca invade o espaço do ego
    const maxZ = -ext.rear - half(F.len) - 2;
    if (F.z > maxZ) { F.z = maxZ; F.kmh = Math.min(F.kmh, state.speed); }
    if (F.z < -220) { F.z = -120; F.kmh = state.speed; } // ficou muito para trás: reaparece no retrovisor
    F.braking = acc < -1;
  }
}
// Extensão do veículo próprio em relação ao motorista (z = 0): a maior entre a física
// (cabine 3D) e a desenhada na 2D. center = onde a 2D desenha o ego.
function egoExtent() {
  const phys = state.vehicle === 'truck' ? { front: 1.3, rear: 15.4 } : { front: 1.0, rear: 3.6 };
  const center = (phys.front - phys.rear) / 2, h = Math.max((phys.front + phys.rear) / 2, half(vehicleLength(state.vehicle)));
  return { front: center + h, rear: h - center, center };
}

/* ---------- velocidade ---------- */
function updateSpeed(dt) {
  const v = VEHICLES[state.vehicle];
  let desired = state.target;
  const intervention = !state.degraded && state.level === 'intervention';
  if (intervention) desired = 0;
  if (state.degraded) desired = state.speed;
  else if (!intervention && desired > 0) {
    state.cruiseT += dt;
    desired += Math.sin(state.cruiseT * .35) * 1.4 + Math.sin(state.cruiseT * 1.1) * .5;
  }
  if (state.speed > desired) {
    const drop = intervention ? v.decel * 3.6 : Math.min(9, (state.speed - desired) * 2 + .5);
    state.speed = Math.max(desired, state.speed - drop * dt);
  } else if (state.speed < desired) {
    state.speed = Math.min(desired, state.speed + Math.min(v.accel * 3.6 * .7, (desired - state.speed) * 2 + .5) * dt);
  }
  world.distance += state.speed / 3.6 * dt;
  world.odometer += state.speed / 3.6 * dt / 1000;

  // Motor ilustrativo: marchas e rotação (sem sensores reais).
  const gears = state.vehicle === 'truck' ? [0, 12, 22, 32, 44, 56, 70, 86, 120] : [0, 18, 34, 54, 76, 100, 160];
  let g = 1;
  while (g < gears.length - 1 && state.speed > gears[g]) g++;
  const lo = gears[g - 1], hi = gears[g];
  const frac = clamp((state.speed - lo) / Math.max(1, hi - lo), 0, 1);
  const idle = state.vehicle === 'truck' ? 650 : 800;
  const top = state.vehicle === 'truck' ? 1900 : 3200;
  const targetRpm = state.speed < 1 ? idle : idle + 350 + frac * (top - idle - 350);
  world.rpm = lerp(world.rpm || idle, targetRpm, clamp(dt * 4, 0, 1));
  world.gearNum = state.speed < 1 ? 0 : g;
  world.gear = state.speed < .5 && intervention ? 'P' : 'D';

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
  const pill = $('statePill');
  pill.textContent = LABEL[l]; pill.className = 'state-pill ' + l;
  $('stateDescription').textContent = DESCRIPTION[l];
  const banner = $('roadAlert');
  banner.className = 'status-banner ' + l;
  $('roadAlertTitle').textContent = BANNER[l][0];
  $('roadAlertCaption').textContent = BANNER[l][1];
  const inter = !state.degraded && state.level === 'intervention';
  $('hazardLabel').textContent = inter ? 'LIGADO' : 'DESLIGADO';
  $('hazardLabel').className = inter ? 'warn' : '';
  $('brakeLabel').textContent = inter && state.speed > .3 ? 'ATIVA' : 'INATIVA';
  $('brakeLabel').className = inter ? 'danger' : '';
  $('driverLabel').textContent = state.driver;
  $('speedCaption').textContent = state.degraded ? 'SINAL DEGRADADO' : inter ? 'REDUÇÃO CONTROLADA' : 'VELOCIDADE ATUAL';
  $('speedMode').textContent = inter ? 'INTERVENÇÃO EM CURSO' : state.degraded ? 'MODO SEGURO · SEM FREIO' : 'CRUZEIRO SIMULADO';
  $('sourceLabel').textContent = '● ' + ({ ia: 'IA NA PÁGINA', websocket: 'WEBSOCKET', replay: 'REPLAY' }[state.channel] || 'MODO MANUAL');
  if (state.degraded) $('roadAlertCaption').textContent = state.degradedReason || BANNER.degraded[1];
  LEVELS.forEach(a => $(a + 'Btn').classList.toggle('active', state.level === a && !state.degraded));
  $('moreSpeed').disabled = $('lessSpeed').disabled = inter;
  $('scene').dataset.level = l;
}

// Velocímetro do painel lateral (SVG).
function angleToPoint(a, r, cx = 160, cy = 120) { const d = a * Math.PI / 180; return [cx + Math.sin(d) * r, cy - Math.cos(d) * r]; }
function arcPath(start, end, r = 94) {
  const steps = Math.max(1, Math.ceil(Math.abs(end - start) / 5)); let p = '';
  for (let i = 0; i <= steps; i++) { const [x, y] = angleToPoint(start + (end - start) * i / steps, r); p += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2) + ' '; }
  return p;
}
function renderGaugeScales() {
  const a = -125, b = 125, max = VEHICLES[state.vehicle].maxSpeed, ns = 'http://www.w3.org/2000/svg';
  $('gaugeTrack').setAttribute('d', arcPath(a, b));
  const ticks = $('gaugeTicks'); ticks.replaceChildren();
  for (let val = 0; val <= max; val += 10) {
    const deg = a + (b - a) * val / max, major = val % 20 === 0;
    const [x1, y1] = angleToPoint(deg, major ? 78 : 82), [x2, y2] = angleToPoint(deg, 87);
    const line = document.createElementNS(ns, 'line');
    Object.entries({ x1, y1, x2, y2, stroke: val > max * .78 ? '#c98a7d' : '#84b7c4', 'stroke-width': major ? 2.4 : 1.2 }).forEach(([k, v]) => line.setAttribute(k, v));
    ticks.append(line);
    if (major) {
      const [tx, ty] = angleToPoint(deg, 66);
      const text = document.createElementNS(ns, 'text');
      Object.entries({ x: tx, y: ty + 3.5, 'text-anchor': 'middle', fill: '#9fb8c6', 'font-size': 10, 'font-weight': 600 }).forEach(([k, v]) => text.setAttribute(k, v));
      text.textContent = String(val); ticks.append(text);
    }
  }
}
let lastGauge = -1;
function renderGauge() {
  const max = VEHICLES[state.vehicle].maxSpeed, frac = clamp(state.speed / max, 0, 1);
  const key = Math.round(state.speed * 4) + '|' + state.target;
  if (key === lastGauge) return; lastGauge = key;
  $('needleGroup').setAttribute('transform', `rotate(${(-125 + 250 * frac).toFixed(2)} 160 120)`);
  $('gaugeProgress').setAttribute('d', arcPath(-125, -125 + 250 * Math.max(.002, frac)));
  $('speedValue').textContent = String(Math.round(state.speed));
  $('targetSpeed').textContent = String(Math.round(state.target));
}

let hudCache = {};
function setText(id, text) { if (hudCache[id] !== text) { hudCache[id] = text; $(id).textContent = text; } }
function updateHud() {
  setText('cycleLabel', (env.phase === 'DIA' ? 'DIA' : env.phase) + ' · ' + clockText());
  setText('cycleSub', env.warp ? 'TRANSIÇÃO…' : env.night > .15 ? 'FARÓIS ALTOS' : 'FARÓIS ACESOS');
  $('cycleDot').style.background = env.night > .5 ? '#8eb5ff' : env.night > .1 ? '#ffa45c' : '#ffdf7a';
}

/* ---------- comandos ---------- */
function setVehicle(v) {
  if (!VEHICLES[v]) return;
  state.vehicle = v; state.level = 'normal'; state.degraded = false;
  state.target = state.speed = cruiseFor(); state.manualTarget = false;
  state.driver = 'AGUARDANDO'; state.ackDone = false; state.ackDeadline = 0;
  seedTraffic();
  $('carBtn').classList.toggle('active', v === 'car'); $('truckBtn').classList.toggle('active', v === 'truck');
  $('carBtn').setAttribute('aria-pressed', v === 'car'); $('truckBtn').setAttribute('aria-pressed', v === 'truck');
  $('cockpitVehicleLabel').textContent = VEHICLES[v].name;
  renderGaugeScales(); lastGauge = -1; renderGauge(); refreshUI();
  emit('vehicle', v);
  log('Veículo selecionado: ' + (v === 'car' ? 'carro familiar' : 'caminhão'), 'vehicle');
}
function changeTarget(delta) {
  const max = VEHICLES[state.vehicle].maxSpeed;
  state.target = clamp(state.target + delta, 0, max); state.manualTarget = true;
  lastGauge = -1; renderGauge();
}
function setViewMode(v) {
  if (!['2d', '3d'].includes(v)) return;
  state.viewMode = v;
  $('scene').classList.toggle('cockpit-view', v === '3d');
  $('view2dBtn').classList.toggle('selected', v === '2d'); $('view3dBtn').classList.toggle('selected', v === '3d');
  $('view2dBtn').setAttribute('aria-pressed', v === '2d'); $('view3dBtn').setAttribute('aria-pressed', v === '3d');
  $('stageTitle').textContent = v === '3d' ? 'Simulação de direção • visão do motorista' : 'Simulação de direção • visão 2D';
  emit('view', v);
  log(v === '3d' ? 'Modo cabine 3D ativado' : 'Visão superior 2D ativada', 'view');
}
function setPaused(p) {
  state.paused = p;
  $('scene').classList.toggle('paused', p);
  $('pauseBtn').textContent = p ? '▶ Continuar' : 'Ⅱ Pausar';
  log(p ? 'Simulação pausada' : 'Simulação retomada', 'pause');
}
function reset() {
  VIGIA.sinal?.fecharCanal('Cenário reiniciado: canal de sinal fechado');
  Object.assign(state, { degraded: false, source: 'manual', level: 'normal', driver: 'AGUARDANDO', ackDeadline: 0, ackDone: false, hazardOn: false, alarmElapsed: 0 });
  state.target = state.speed = cruiseFor(); state.manualTarget = false;
  seedTraffic();
  if (state.paused) setPaused(false);
  lastGauge = -1; renderGauge(); refreshUI(); emit('level', 'normal');
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
const motion = { t: 0, steer: 0, roll: 0, bob: 0, kick: 0 };
function updateMotion(dt) {
  const k = clamp(state.speed / 40, 0, 1) * (state.reduceMotion ? 0 : 1), t = (motion.t += dt);
  motion.kick = Math.max(0, motion.kick - dt * 2.2);
  const jolt = motion.kick * (Math.sin(t * 31) * .6 + Math.sin(t * 17) * .4);
  motion.steer = (Math.sin(t * .33) * 1.5 + Math.sin(t * .91 + 1.3) * .6 + Math.sin(t * 2.3) * .12) * k; // graus
  motion.roll = ((Math.sin(t * .47) * .16 + Math.sin(t * 1.3) * .06) * k + jolt * .25) * Math.PI / 180;
  motion.bob = (Math.sin(t * 1.9) * .8 + Math.sin(t * 5.1 + .5) * .35) * k + jolt * 1.6; // px
}
on('pass', t => { motion.kick = Math.max(motion.kick, isHeavy(t.kind) ? 1 : .35); });

/* ---------- laço principal ---------- */
let lastFrame = 0;
const renderers = [];
function frame(time) {
  const dt = Math.min((time - (lastFrame || time)) / 1000, .08);
  lastFrame = time;
  if (!state.paused) {
    updateSpeed(dt);
    updateTraffic(dt);
    updateEnv(dt);
    updateMotion(dt);
    updateZones(dt);
    updatePeds(dt);
    const inter = !state.degraded && state.level === 'intervention';
    state.blinkElapsed += dt; state.alarmElapsed += dt;
    if (state.blinkElapsed > .55) {
      state.blinkElapsed = 0;
      state.hazardOn = inter ? !state.hazardOn : false;
      if (inter) emit('blink', state.hazardOn);
    }
    if ((state.level === 'critical' || state.level === 'intervention' || state.level === 'attention') && !state.degraded) {
      const every = state.level === 'attention' ? 6 : state.level === 'critical' ? 2.6 : 2.2;
      if (state.alarmElapsed > every) { state.alarmElapsed = 0; emit('alarm', state.level); }
    }
    if (state.ackDeadline && now() > state.ackDeadline && !state.ackDone) {
      state.ackDeadline = 0; state.driver = 'SEM RESPOSTA'; refreshUI();
      log('Prazo de resposta do motorista excedido', 'timeout');
    }
    if (inter && Math.random() < dt * 2) refreshUI(); // atualiza "Frenagem ativa/inativa"
  }
  renderGauge();
  updateHud();
  for (const r of renderers) { try { r(dt, time); } catch (e) { console.error(e); } }
  requestAnimationFrame(frame);
}

function bind() {
  $('carBtn').onclick = () => setVehicle('car');
  $('truckBtn').onclick = () => setVehicle('truck');
  $('moreSpeed').onclick = () => changeTarget(5);
  $('lessSpeed').onclick = () => changeTarget(-5);
  // botões manuais assumem o comando: fecham o canal de sinal ativo
  LEVELS.forEach(l => $(l + 'Btn').onclick = () => { VIGIA.sinal?.fecharCanal('Modo manual: canal de sinal fechado'); setLevel(l, 'manual'); });
  $('ackBtn').onclick = acknowledge;
  $('hornBtn').onclick = () => { emit('horn'); log('Buzina testada', 'audio'); };
  $('replayBtn').onclick = () => VIGIA.sinal?.replayGuiado();
  $('resetBtn').onclick = reset;
  $('pauseBtn').onclick = () => setPaused(!state.paused);
  $('view2dBtn').onclick = () => setViewMode('2d');
  $('view3dBtn').onclick = () => setViewMode('3d');
  $('cycleToggle').onclick = toggleDayNight;
  $('wsBtn').onclick = () => VIGIA.sinal?.conectarWS($('wsUrl').value.trim());
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
  $('fullscreenBtn').onclick = () => {
    const el = $('stageCard');
    if (document.fullscreenElement) document.exitFullscreen?.(); else el.requestFullscreen?.().catch(() => {});
  };
  document.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea')) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); setPaused(!state.paused); }
    else if (k === 'v') setViewMode(state.viewMode === '2d' ? '3d' : '2d');
    else if (k === 'n') toggleDayNight();
    else if (k === 'a') acknowledge();
    else if (k === 'h') emit('horn');
    else if (k === 'c') scheduleZoneSwitch(250); // atalho: troca de cenário logo à frente
    else if (['1', '2', '3', '4'].includes(k)) setLevel(LEVELS[Number(k) - 1], 'manual');
  });
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
  cityAmount, cityRanges, crossingsBetween, nearCrossing, scheduleZoneSwitch, zoneAt, ROAD, VEHICLES, LABEL, DISPLAY_SCALE, egoExtent,
  clamp, lerp, smooth, on, emit, log, signsBetween, clockText, effectiveLevel,
  setLevel, setDegraded, refreshUI, setVehicle, setViewMode, reset, acknowledge, toggleDayNight,
  addRenderer: fn => renderers.push(fn),
  getState: () => ({ night: env.night > .5, nightAmount: env.night, timeOfDay: env.timeOfDay, viewMode: state.viewMode, vehicle: state.vehicle, level: state.level, speed: state.speed, target: state.target, degraded: state.degraded, traffic: world.traffic.length, audioActive: !!VIGIA.audio?.enabled, cameraActive: !!VIGIA.monitor?.cameraActive }),
  trafficSnapshot: () => world.traffic.map(t => ({ id: t.id, z: t.z, kind: t.kind, len: t.len })),
  // avança a simulação sem depender da animação (testes automatizados)
  step: (dt = 1 / 30) => { updateSpeed(dt); updateTraffic(dt); },
  setTimeOfDay: h => { env.warp = null; env.timeOfDay = ((h % 24) + 24) % 24; computeEnv(); }
};

document.addEventListener('DOMContentLoaded', () => {
  computeEnv();
  bind();
  state.target = state.speed = cruiseFor();
  seedTraffic(); initPeds();
  renderGaugeScales(); renderGauge(); refreshUI(); syncSettingsLabels();
  emit('ready');
  log('Simulador VIGIA (Parte 3) pronto · scanner e câmera opcionais', 'startup');
  requestAnimationFrame(frame);
});
})();
