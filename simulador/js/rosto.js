// Olhos, boca, cabeça e olhar do motorista, espelhando entrada/rosto.py (Parte 1).
// Funções puras (sem DOM nem MediaPipe): rodam no navegador e no Node (testes/js/rosto.test.mjs).
// Direções são descritas do ponto de vista do motorista: a câmera não espelha a imagem,
// então quando ele olha para a esquerda dele, o rosto e as íris vão para a direita da imagem.

export const LIMIAR_CABECA_GRAUS = 15;
export const LIMIAR_OLHAR = 0.2; // deslocamento da íris, em metades da largura do olho

const numero = (v, casas) => v.toFixed(casas).replace(".", ",");
const duracao = (ms) => `${numero(ms / 1000, 2)} s`;

// Vetor unitário para onde o rosto aponta: o eixo z do modelo do rosto (terceira coluna da
// rotação da matriz 4x4 do MediaPipe, em linhas), com x para a direita da imagem, y para cima
// e z para a câmera.
export function direcaoDaCabeca(matriz) {
  const f = [matriz[0][2], matriz[1][2], matriz[2][2]];
  const n = Math.hypot(...f);
  return f.map((v) => v / n);
}

// (horizontal, vertical) em graus: positivos para a direita da imagem e para cima.
export function angulosDaDirecao([x, y, z]) {
  const graus = (r) => (r * 180) / Math.PI;
  return [graus(Math.atan2(x, z)), graus(Math.atan2(y, z))];
}

// Rótulo como "frente", "baixo" ou "baixo e esquerda", do ponto de vista do motorista.
export function descrever(horizontal, vertical, limiar) {
  const partes = [];
  if (vertical > limiar) partes.push("cima");
  else if (vertical < -limiar) partes.push("baixo");
  if (horizontal > limiar) partes.push("esquerda"); // direita da imagem
  else if (horizontal < -limiar) partes.push("direita");
  return partes.join(" e ") || "frente";
}

export function rotuloDaCabeca(matriz) {
  return descrever(...angulosDaDirecao(direcaoDaCabeca(matriz)), LIMIAR_CABECA_GRAUS);
}

// Para cada olho: centro, eixo unitário (cantos, para a direita da imagem), meia largura e
// os 5 pontos da íris (o primeiro é o centro). `pontos` em pixels ou normalizados.
export function olhos(pontos, indices) {
  return [["olho_direito", "iris_direita"], ["olho_esquerdo", "iris_esquerda"]].map(([olho, iris]) => {
    const a = pontos[indices[olho][0]], b = pontos[indices[olho][3]];
    const largura = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return {
      centro: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      eixo: [(b[0] - a[0]) / largura, (b[1] - a[1]) / largura],
      meia: largura / 2,
      iris: indices[iris].map((i) => pontos[i]),
    };
  });
}

// Deslocamento médio das íris em relação ao centro dos olhos, ao longo do eixo de cada olho
// (dx, positivo para a direita da imagem) e na perpendicular (dy, positivo para baixo), em
// metades da largura do olho: inclinar a cabeça não é lido como olhar para cima ou para baixo.
export function olharDaIris(pontos, indices) {
  const d = olhos(pontos, indices).map(({ centro, eixo, meia, iris }) => {
    const normal = [-eixo[1], eixo[0]], v = [iris[0][0] - centro[0], iris[0][1] - centro[1]];
    return [(v[0] * eixo[0] + v[1] * eixo[1]) / meia, (v[0] * normal[0] + v[1] * normal[1]) / meia];
  });
  return [(d[0][0] + d[1][0]) / 2, (d[0][1] + d[1][1]) / 2];
}

export function rotuloDoOlhar(pontos, indices) {
  const [dx, dy] = olharDaIris(pontos, indices);
  return descrever(dx, -dy, LIMIAR_OLHAR);
}

// Acompanha olhos e boca quadro a quadro e anuncia piscadas, olhos fechados e bocejos,
// com os limiares de `rosto` em config/analise.json.
export class MonitorRosto {
  constructor(limiares) {
    this.lim = limiares;
    this.reiniciar();
  }

  reiniciar() {
    this.olhosDesde = this.bocaDesde = null;
    this.alertouOlhos = this.alertouBocejo = false;
  }

  // ear e abertura já calculados (null sem rosto); devolve o estado e os eventos do quadro.
  registrar(tMs, ear, abertura, cabeca = null) {
    if (ear == null || abertura == null) {
      this.reiniciar(); // sem rosto não dá para saber o que aconteceu: recomeça do zero
      return { olhos: null, ear: null, boca: null, abertura: null, cabeca: null, eventos: [] };
    }
    const [fechados, eo] = this.#olhos(tMs, ear), [aberta, eb] = this.#boca(tMs, abertura);
    // bocejando: a boca segue aberta depois do evento "bocejo" (para o selo na tela)
    return { olhos: fechados ? "fechados" : "abertos", ear, boca: aberta ? "aberta" : "fechada",
      abertura, cabeca, eventos: [...eo, ...eb], bocejando: aberta && this.alertouBocejo };
  }

  #olhos(tMs, ear) {
    const lim = this.lim;
    if (ear < lim.ear_olho_fechado) {
      this.olhosDesde ??= tMs;
      if (this.alertouOlhos || tMs - this.olhosDesde < lim.olhos_fechados_alerta_ms) return [true, []];
      this.alertouOlhos = true;
      return [true, [`olhos fechados há mais de ${String(lim.olhos_fechados_alerta_ms / 1000).replace(".", ",")} s`]];
    }
    if (this.olhosDesde == null) return [false, []];
    const d = tMs - this.olhosDesde;
    const evento = d <= lim.piscada_max_ms ? `piscada (${duracao(d)})`
      : this.alertouOlhos ? `olhos reabertos após ${duracao(d)}` : `olhos fechados por ${duracao(d)}`;
    this.olhosDesde = null; this.alertouOlhos = false;
    return [false, [evento]];
  }

  #boca(tMs, abertura) {
    const lim = this.lim;
    if (abertura <= lim.abertura_boca_aberta) { this.bocaDesde = null; this.alertouBocejo = false; return [false, []]; }
    this.bocaDesde ??= tMs;
    if (this.alertouBocejo || tMs - this.bocaDesde < lim.bocejo_min_ms) return [true, []];
    this.alertouBocejo = true;
    return [true, ["bocejo"]];
  }
}
