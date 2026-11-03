import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { criarServidor } from "../../scripts/servidor.mjs";

// Raiz temporária com um arquivo de 10 bytes e um "segredo" fora dela.
const base = mkdtempSync(join(tmpdir(), "servidor-"));
const raiz = join(base, "raiz");
mkdirSync(raiz);
writeFileSync(join(raiz, "dez.bin"), "0123456789");
writeFileSync(join(base, "segredo.txt"), "fora da raiz");
let servidor, porta;

before(async () => {
  servidor = criarServidor(raiz);
  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  porta = servidor.address().port;
});
after(() => {
  servidor.close();
  rmSync(base, { recursive: true, force: true });
});

// http.request, e não fetch, para enviar o caminho cru, sem normalização.
function obter(caminho, cabecalhos = {}) {
  return new Promise((ok, erro) => {
    request({ host: "127.0.0.1", port: porta, path: caminho, headers: cabecalhos }, (res) => {
      let corpo = "";
      res.on("data", (d) => (corpo += d));
      res.on("end", () => ok({ status: res.statusCode, cabecalhos: res.headers, corpo }));
    }).on("error", erro).end();
  });
}

test("URL malformada responde 400 e o servidor continua de pé", async () => {
  assert.equal((await obter("/%E0%A4%A")).status, 400);
  const depois = await obter("/dez.bin");
  assert.equal(depois.status, 200);
  assert.equal(depois.corpo, "0123456789");
});

test("faixa comum", async () => {
  const r = await obter("/dez.bin", { Range: "bytes=2-4" });
  assert.equal(r.status, 206);
  assert.equal(r.corpo, "234");
  assert.equal(r.cabecalhos["content-range"], "bytes 2-4/10");
});

test("faixa com sufixo devolve os últimos bytes", async () => {
  const r = await obter("/dez.bin", { Range: "bytes=-4" });
  assert.equal(r.status, 206);
  assert.equal(r.corpo, "6789");
  assert.equal(r.cabecalhos["content-range"], "bytes 6-9/10");
});

test("fim além do tamanho é limitado ao último byte", async () => {
  const r = await obter("/dez.bin", { Range: "bytes=5-999" });
  assert.equal(r.status, 206);
  assert.equal(r.corpo, "56789");
  assert.equal(r.cabecalhos["content-length"], "5");
  assert.equal(r.cabecalhos["content-range"], "bytes 5-9/10");
});

test("faixa impossível responde 416", async () => {
  for (const faixa of ["bytes=20-", "bytes=5-2", "bytes=-0"]) {
    const r = await obter("/dez.bin", { Range: faixa });
    assert.equal(r.status, 416, faixa);
    assert.equal(r.cabecalhos["content-range"], "bytes */10", faixa);
  }
});

test("não serve arquivos fora da raiz", async () => {
  for (const caminho of ["/../segredo.txt", "/..%2Fsegredo.txt", "/%2e%2e/segredo.txt"]) {
    const r = await obter(caminho);
    assert.notEqual(r.status, 200, caminho);
    assert.ok(!r.corpo.includes("fora da raiz"), caminho);
  }
});
