// Cálculo das métricas por quadro, espelhando entrada/geometria.py,
// entrada/confianca.py e entrada/metricas.py. Não usa DOM nem MediaPipe, então
// roda também no Node e passa pelos casos de testes/casos/geometria.json.

export function distancia(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Eye Aspect Ratio de seis pontos p1..p6: (|p2-p6| + |p3-p5|) / (2 |p1-p4|).
export function ear(p) {
  const largura = distancia(p[0], p[3]);
  if (largura === 0) return 0;
  return (distancia(p[1], p[5]) + distancia(p[2], p[4])) / (2 * largura);
}

export function aberturaBoca(paresVerticais, cantoA, cantoB) {
  const largura = distancia(cantoA, cantoB);
  if (largura === 0) return 0;
  const soma = paresVerticais.reduce((s, [a, b]) => s + distancia(a, b), 0);
  return soma / paresVerticais.length / largura;
}

// O MediaPipe JS entrega a matriz como lista achatada do proto MatrixData,
// cujo layout padrão é por colunas. Devolve linhas [[...], ...].
export function matrizEmLinhas({ rows, columns, data }) {
  const m = [];
  for (let r = 0; r < rows; r++) {
    m.push([]);
    for (let c = 0; c < columns; c++) m[r].push(data[c * rows + r]);
  }
  return m;
}

// (yaw, pitch, roll) em graus, decomposição ZYX: R = Rz(roll)·Ry(yaw)·Rx(pitch).
export function angulosDaMatriz(m) {
  const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[i][j]));
  for (let j = 0; j < 3; j++) {
    const n = Math.hypot(r[0][j], r[1][j], r[2][j]);
    for (let i = 0; i < 3; i++) r[i][j] /= n;
  }
  const graus = (x) => (x * 180) / Math.PI;
  return {
    yaw: graus(Math.atan2(-r[2][0], Math.hypot(r[2][1], r[2][2]))),
    pitch: graus(Math.atan2(r[2][1], r[2][2])),
    roll: graus(Math.atan2(r[1][0], r[0][0])),
  };
}

// RMS do resíduo entre dois conjuntos de pontos 2D após alinhamento por
// semelhança (translação, rotação e escala), com s = Σ conj(a)·b / Σ |a|².
export function residuoAlinhado(anterior, atual) {
  const n = anterior.length;
  const media = (pts, k) => pts.reduce((s, p) => s + p[k], 0) / n;
  const [ax, ay, bx, by] = [media(anterior, 0), media(anterior, 1), media(atual, 0), media(atual, 1)];
  let energia = 0, sRe = 0, sIm = 0;
  for (let i = 0; i < n; i++) {
    const [ar, ai] = [anterior[i][0] - ax, anterior[i][1] - ay];
    const [br, bi] = [atual[i][0] - bx, atual[i][1] - by];
    energia += ar * ar + ai * ai;
    sRe += ar * br + ai * bi;   // conj(a)·b, parte real
    sIm += ar * bi - ai * br;   // conj(a)·b, parte imaginária
  }
  if (energia === 0) return 0;
  sRe /= energia;
  sIm /= energia;
  let soma = 0;
  for (let i = 0; i < n; i++) {
    const [ar, ai] = [anterior[i][0] - ax, anterior[i][1] - ay];
    const [br, bi] = [atual[i][0] - bx, atual[i][1] - by];
    const dr = br - (sRe * ar - sIm * ai);
    const di = bi - (sRe * ai + sIm * ar);
    soma += dr * dr + di * di;
  }
  return Math.sqrt(soma / n);
}

export class Estabilidade {
  constructor(parametros) {
    this.p = parametros;
    this.anterior = null;
    this.tAnterior = null;
    this.residuo = null;
  }

  atualizar(pontosRigidos, tMs, distanciaRef) {
    if (pontosRigidos === null || distanciaRef <= 0) {
      this.anterior = this.tAnterior = this.residuo = null;
      return 0;
    }
    const continua = this.anterior !== null && tMs - this.tAnterior <= this.p.intervalo_max_ms;
    let confianca;
    if (continua) {
      const r = residuoAlinhado(this.anterior, pontosRigidos) / distanciaRef;
      const a = this.p.alfa_suavizacao;
      this.residuo = this.residuo === null ? r : a * r + (1 - a) * this.residuo;
      confianca = Math.exp(-this.residuo / this.p.escala_residuo);
    } else {
      this.residuo = null;
      confianca = this.p.valor_inicial;
    }
    this.anterior = pontosRigidos;
    this.tAnterior = tMs;
    return confianca;
  }
}

// Pontos normalizados do MediaPipe em pixels: [[x, y], ...].
export function pontosEmPixels(landmarks, largura, altura) {
  return landmarks.map((p) => [p.x * largura, p.y * altura]);
}

export class CalculadoraMetricas {
  constructor(parametrosConfianca, indices) {
    this.ip = indices;
    this.estabilidade = new Estabilidade(parametrosConfianca);
  }

  // pts: [[x, y], ...] em pixels, ou null sem rosto; matriz: linhas 4x4 ou null.
  calcular(pts, matriz, tMs, quadro, atrasoMs = null) {
    const vazio = {
      t_ms: tMs, quadro, rosto_visivel: false, ear_esq: null, ear_dir: null,
      abertura_boca: null, yaw: null, pitch: null, roll: null, confianca: 0, atraso_ms: atrasoMs,
    };
    if (pts === null) {
      vazio.confianca = this.estabilidade.atualizar(null, tMs, 0);
      return vazio;
    }
    const ip = this.ip;
    const sel = (indices) => indices.map((i) => pts[i]);
    const [refA, refB] = ip.referencia_escala;
    const confianca = this.estabilidade.atualizar(
      sel(ip.rigidos), tMs, distancia(pts[refA], pts[refB]));
    const pose = matriz ? angulosDaMatriz(matriz) : { yaw: null, pitch: null, roll: null };
    const [cantoA, cantoB] = ip.boca_cantos;
    return {
      ...vazio,
      rosto_visivel: true,
      ear_esq: ear(sel(ip.olho_esquerdo)),
      ear_dir: ear(sel(ip.olho_direito)),
      abertura_boca: aberturaBoca(
        ip.boca_pares_verticais.map(([a, b]) => [pts[a], pts[b]]), pts[cantoA], pts[cantoB]),
      ...pose,
      confianca,
    };
  }
}

// Marcas de tempo da webcam a partir do requestVideoFrameCallback. O t_ms é o
// instante de captura (metadata.captureTime, ou o now do callback quando a
// câmera não o informa), contado desde a captura do primeiro quadro, como o
// relógio da webcam em entrada/fontes.py. A captura é limitada ao now, já que
// um quadro não pode ter sido capturado depois de entregue. Devolve null quando
// a marca não avança, porque o MediaPipe exige marcas estritamente crescentes.
export class RelogioWebcam {
  constructor() {
    this.t0 = null;
    this.ultimo = -1;
  }

  quadro(agora, metadados) {
    const captura = Math.min(metadados?.captureTime ?? agora, agora);
    if (this.t0 === null) this.t0 = captura;
    const tMs = Math.round(captura - this.t0);
    if (tMs <= this.ultimo) return null;
    this.ultimo = tMs;
    return { tMs, captura };
  }
}

// CSV no formato de contratos/metricas.v1.json.
export function cabecalhoCsv(contrato) {
  return contrato.colunas.map((c) => c.nome).join(",");
}

export function linhaCsv(contrato, registro) {
  return contrato.colunas.map((c) => {
    const v = registro[c.nome];
    if (v === null || v === undefined) return "";
    if (c.tipo === "booleano") return v ? "1" : "0";
    if (c.tipo === "inteiro") return String(Math.trunc(v));
    return v.toFixed(c.casas);
  }).join(",");
}
