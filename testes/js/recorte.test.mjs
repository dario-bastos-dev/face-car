// Recorte do rosto no simulador (simulador/js/recorte.js): os mesmos casos de
// testes/entrada/test_classificador.py, para a página mandar ao modelo a mesma imagem da análise
// em Python e do treino (treinamento/modelo.ipynb).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FATOR_RECORTE, caixaDoRosto } from "../../simulador/js/recorte.js";

const CASOS = JSON.parse(readFileSync(new URL("../casos/recorte.json", import.meta.url), "utf8"));

test("fator do recorte igual ao da análise em Python", () => {
  assert.equal(FATOR_RECORTE, CASOS.fator);
});

for (const c of CASOS.casos) {
  test(`caixa do rosto: ${c.nome}`, () => {
    assert.deepEqual(caixaDoRosto(c.pontos, c.largura, c.altura), c.esperado);
  });
}
