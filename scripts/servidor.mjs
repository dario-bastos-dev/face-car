// Servidor estático da raiz do projeto, com suporte a Range (o navegador
// precisa disso para buscar quadros em vídeos mp4).
//   node scripts/servidor.mjs [porta]   →   http://localhost:8000/demo-navegador/
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = resolve(fileURLToPath(import.meta.url), "../..");

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".csv": "text/csv", ".mp4": "video/mp4", ".webm": "video/webm",
  ".task": "application/octet-stream",
};

// Cabeçalho Range de uma única faixa (RFC 9110): devolve {inicio, fim}, "invalida"
// (responder 416) ou null (sem Range ou com várias faixas: servir o arquivo inteiro).
export function interpretarFaixa(texto, tamanho) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((texto ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let inicio, fim;
  if (m[1] === "") {  // sufixo: os últimos N bytes
    const n = Number(m[2]);
    if (n === 0) return "invalida";
    inicio = Math.max(0, tamanho - n);
    fim = tamanho - 1;
  } else {
    inicio = Number(m[1]);
    fim = m[2] === "" ? tamanho - 1 : Math.min(Number(m[2]), tamanho - 1);
  }
  if (inicio >= tamanho || fim < inicio) return "invalida";
  return { inicio, fim };
}

// extras: mapa de rotas para arquivos fora da raiz, por exemplo {"/__video": "/abs/v.mp4"}.
export function criarServidor(raiz = RAIZ, extras = {}) {
  return createServer((req, res) => {
    let rota;
    try {
      rota = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      return res.writeHead(400).end("URL inválida");
    }
    let caminho = extras[rota] ?? join(raiz, normalize(rota));
    if (!extras[rota] && !caminho.startsWith(raiz)) return res.writeHead(403).end();
    let info;
    try {
      info = statSync(caminho);
      if (info.isDirectory()) info = statSync((caminho = join(caminho, "index.html")));
    } catch {
      return res.writeHead(404).end("não encontrado");
    }
    const cabecalho = {
      "Content-Type": TIPOS[extname(caminho)] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    const faixa = interpretarFaixa(req.headers.range, info.size);
    if (faixa === "invalida") {
      res.writeHead(416, { ...cabecalho, "Content-Range": `bytes */${info.size}` }).end();
    } else if (faixa) {
      const { inicio, fim } = faixa;
      res.writeHead(206, { ...cabecalho, "Content-Range": `bytes ${inicio}-${fim}/${info.size}`,
        "Content-Length": fim - inicio + 1 });
      createReadStream(caminho, { start: inicio, end: fim }).pipe(res);
    } else {
      res.writeHead(200, { ...cabecalho, "Content-Length": info.size });
      createReadStream(caminho).pipe(res);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const porta = Number(process.argv[2] ?? 8000);
  criarServidor().listen(porta, "127.0.0.1", () =>
    console.log(`Demo em http://localhost:${porta}/demo-navegador/`));
}
