// Roda o extrator do navegador sobre um vídeo, no Chrome sem janela, e grava o CSV.
// Serve para comparar com o extrator em Python nos mesmos vídeos:
//   node scripts/extrair_navegador.mjs testes/dados/retrato.mp4 saidas/retrato-js.csv [--fps N]
//   uv run python -m entrada comparar saidas/retrato-py.csv saidas/retrato-js.csv
// Sem --fps, a taxa é lida do vídeo com o ffprobe, como o Python faz com o OpenCV.
// O Chrome é procurado em $CHROME, google-chrome-stable, google-chrome e chromium.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { criarServidor } from "./servidor.mjs";
import { fpsDoVideo, interpretarTaxa } from "./fps.mjs";

const args = process.argv.slice(2);
const iFps = args.indexOf("--fps");
const fpsInformado = iFps >= 0 ? args.splice(iFps, 2)[1] : null;
const [video, saida] = args;
if (!video || !saida) {
  console.error("uso: node scripts/extrair_navegador.mjs <video> <saida.csv> [--fps N]");
  process.exit(2);
}
let fps;
try {
  fps = fpsInformado !== null ? interpretarTaxa(fpsInformado) : fpsDoVideo(video);
} catch (erro) {
  console.error(erro.message);
  process.exit(2);
}
console.log(`${video}: ${fps.toFixed(3)} fps`);

function acharChrome() {
  for (const nome of [process.env.CHROME, "google-chrome-stable", "google-chrome", "chromium"]) {
    if (!nome) continue;
    try { return execFileSync("which", [nome]).toString().trim(); } catch {}
  }
  throw new Error("Chrome não encontrado; defina a variável CHROME");
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const servidor = criarServidor(undefined, { "/__video": resolve(video) });
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const porta = servidor.address().port;

const perfil = mkdtempSync(join(tmpdir(), "extrator-chrome-"));
const chrome = spawn(acharChrome(), [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${perfil}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

try {
  // O Chrome anuncia a porta do DevTools no stderr.
  const wsNavegador = await new Promise((ok, erro) => {
    let texto = "";
    chrome.stderr.on("data", (d) => {
      texto += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(texto);
      if (m) ok(m[1]);
    });
    chrome.on("exit", () => erro(new Error("Chrome encerrou:\n" + texto)));
  });
  const portaDevtools = new URL(wsNavegador).port;
  const abas = await (await fetch(`http://127.0.0.1:${portaDevtools}/json`)).json();
  const ws = new WebSocket(abas.find((a) => a.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let id = 0;
  const pendentes = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pendentes.has(msg.id)) {
      pendentes.get(msg.id)(msg);
      pendentes.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") {
      console.error("Erro na página:", msg.params.exceptionDetails.exception?.description);
    }
  });
  const cdp = (method, params = {}) => new Promise((r) => {
    pendentes.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const avaliar = async (expressao) =>
    (await cdp("Runtime.evaluate", { expression: expressao, returnByValue: true })).result?.result?.value;

  await cdp("Runtime.enable");
  const url = `http://127.0.0.1:${porta}/demo-navegador/?video=/__video&fps=${fps}`;
  await cdp("Page.navigate", { url });

  const limite = Date.now() + 10 * 60 * 1000;
  let ultimo = "", falha = null;
  while (Date.now() < limite) {
    await esperar(500);
    const estado = await avaliar("JSON.stringify({ok: document.body?.dataset.concluido, " +
      "erro: document.body?.dataset.erro, txt: document.getElementById('estado')?.textContent})");
    if (!estado) continue;
    const { ok, erro, txt } = JSON.parse(estado);
    if (txt !== ultimo) process.stdout.write(`\r${txt}          `);
    ultimo = txt;
    if (erro) {
      falha = erro;
      break;
    }
    if (ok) break;
  }
  process.stdout.write("\n");
  if (falha) throw new Error(`A página falhou: ${falha}`);
  const csv = await avaliar("window.csvMetricas && document.body.dataset.concluido ? window.csvMetricas() : null");
  if (!csv) throw new Error(`A página não terminou: ${ultimo}`);
  mkdirSync(dirname(resolve(saida)), { recursive: true });
  writeFileSync(saida, csv);
  console.log(`Métricas do navegador gravadas em ${saida}`);
  ws.close();
} catch (erro) {
  console.error(erro.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  servidor.close();
  await esperar(300);
  rmSync(perfil, { recursive: true, force: true });
}
