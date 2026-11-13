// Recorte do rosto para o modelo de imagens, com a mesma regra de entrada/classificador.py
// (caixa_do_rosto): os casos de testes/casos/recorte.json conferem que as duas dão o mesmo.
// Só vale para modelos treinados com o rosto ("recorte": "rosto" no .classes.json do modelo).

export const FATOR_RECORTE = 1.4; // lado do quadrado = maior lado da caixa dos pontos × este fator

// [x, y, lado] do quadrado do rosto, em pixels, dentro da imagem: centrado na caixa dos pontos e,
// perto da borda, empurrado para dentro; nunca passa do menor lado da imagem.
export function caixaDoRosto(pontos, largura, altura, fator = FATOR_RECORTE) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pontos) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const lado = Math.min(Math.max(x1 - x0, y1 - y0) * fator, largura, altura);
  const x = Math.min(Math.max((x0 + x1) / 2 - lado / 2, 0), largura - lado);
  const y = Math.min(Math.max((y0 + y1) / 2 - lado / 2, 0), altura - lado);
  return [Math.round(x), Math.round(y), Math.round(lado)];
}
