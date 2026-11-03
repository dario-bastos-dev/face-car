import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { interpretarTaxa, fpsDoVideo } from "../../scripts/fps.mjs";

test("interpreta a taxa de quadros do ffprobe", () => {
  assert.equal(interpretarTaxa("25/1"), 25);
  assert.ok(Math.abs(interpretarTaxa("30000/1001") - 29.97003) < 1e-4);
  assert.equal(interpretarTaxa("30"), 30);
  assert.throws(() => interpretarTaxa("0/0"));
  assert.throws(() => interpretarTaxa(""));
});

test("lê o fps de um vídeo real", (t) => {
  const video = fileURLToPath(new URL("../dados/retrato.mp4", import.meta.url));
  if (!existsSync(video) || spawnSync("ffprobe", ["-version"]).error?.code === "ENOENT") {
    t.skip("Requer ffprobe e vídeo: execute scripts/preparar.sh (Parte 1)");
    return;
  }
  assert.equal(fpsDoVideo(video), 30);
});

test("falha com mensagem clara para arquivo inexistente", () => {
  assert.throws(() => fpsDoVideo("/nao/existe.mp4"), /fps/);
});
