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

// extras: mapa de rotas para arquivos fora da raiz, por exemplo {"/__video": "/abs/v.mp4"}.
export function criarServidor(raiz = RAIZ, extras = {}) {
  return createServer((req, res) => {
    const rota = decodeURIComponent(new URL(req.url, "http://x").pathname);
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
    const faixa = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    if (faixa) {
      const inicio = faixa[1] ? Number(faixa[1]) : 0;
      const fim = faixa[2] ? Number(faixa[2]) : info.size - 1;
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
