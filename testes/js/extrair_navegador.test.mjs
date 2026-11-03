// Precisa do Chrome; é pulado se ele não estiver instalado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/extrair_navegador.mjs", import.meta.url));
const temChrome = ["google-chrome-stable", "google-chrome", "chromium"].some((n) => {
  try { execFileSync("which", [n], { stdio: "ignore" }); return true; } catch { return false; }
});

function rodar(args, limiteMs) {
  return new Promise((ok) => {
    const inicio = Date.now();
    const p = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let saida = "";
    p.stdout.on("data", (d) => (saida += d));
    p.stderr.on("data", (d) => (saida += d));
    const relogio = setTimeout(() => p.kill("SIGKILL"), limiteMs);
    p.on("exit", (codigo) => {
      clearTimeout(relogio);
      ok({ codigo, saida, ms: Date.now() - inicio });
    });
  });
}

test("vídeo ilegível encerra logo, com a mensagem da página", { skip: !temChrome }, async () => {
  const pasta = mkdtempSync(join(tmpdir(), "extrair-"));
  try {
    const falso = join(pasta, "falso.mp4");
    writeFileSync(falso, "isto não é um vídeo");
    const r = await rodar([falso, join(pasta, "saida.csv"), "--fps", "30"], 60_000);
    assert.notEqual(r.codigo, null, `não encerrou em 60 s:\n${r.saida}`);
    assert.notEqual(r.codigo, 0);
    assert.match(r.saida, /Não foi possível abrir o vídeo/);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});
